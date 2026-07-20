import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { Store } from './database.js';
import { CodexAgentAdapter } from './codex-adapter.js';
import { ClaudeAgentAdapter } from './claude-adapter.js';
import { createJobSchema, createProjectSchema, followUpSchema, idParamsSchema, projectRepositoryParamsSchema, promoteJobSchema, replySchema, scopeDecisionSchema, updateProjectPromotionPolicySchema, updateRepositoryPromotionPolicySchema } from './schemas.js';
import { JobEventBus, JobWorker, MockAgentAdapter } from './worker.js';
import { issueAccessToken, LoginRateLimiter, verifyAccessToken, verifyPassword } from './auth.js';
import { PromotionConflictError, PromotionService } from './promotion.js';
import { DeploymentCoordinator, systemdDeploymentStarter, type DeploymentStarter } from './deployment.js';
import { DEPLOYMENT_STATUSES } from './types.js';

export interface AppOptions {
  databasePath?: string;
  workspaceRoot?: string;
  apiToken?: string;
  appPasswordHash?: string;
  appSessionSecret?: string;
  appTokenTtlSeconds?: number;
  appOrigins?: string[];
  now?: () => number;
  loginRateLimit?: number;
  loginRateWindowMs?: number;
  logger?: boolean;
  loggerStream?: Writable;
  mockStepDelayMs?: number;
  codexBin?: string;
  claudeBin?: string;
  claudeModel?: string;
  runsRoot?: string;
  jobTimeoutMs?: number;
  jobKillGraceMs?: number;
  allowMockAgent?: boolean;
  backendDeployRepositoryPath?: string;
  deploymentApiToken?: string;
  deploymentStarter?: DeploymentStarter;
}

export interface CommandCenterApp {
  app: FastifyInstance;
  store: Store;
  worker: JobWorker;
}

function validatedRepositoryPath(input: string, workspaceRoot: string): string {
  const root = realpathSync(workspaceRoot);
  const candidate = resolve(root, input);
  const rel = relative(root, candidate);
  if (!isAbsolute(candidate) || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Repository path must be inside WORKSPACE_ROOT');
  const actual = realpathSync(candidate);
  const actualRel = relative(root, actual);
  if (actualRel.startsWith('..') || isAbsolute(actualRel)) throw new Error('Repository path must be inside WORKSPACE_ROOT');
  return actual;
}

export async function buildApp(options: AppOptions = {}): Promise<CommandCenterApp> {
  const logger = options.loggerStream
    ? { level: 'info', stream: options.loggerStream, redact: { paths: ['req.headers.authorization', 'req.body.password', 'req.body.prompt', 'req.body.message', 'res.body.accessToken'], censor: '[REDACTED]' } }
    : (options.logger ? { redact: { paths: ['req.headers.authorization', 'req.body.password', 'req.body.prompt', 'req.body.message', 'res.body.accessToken'], censor: '[REDACTED]' } } : false);
  const app = Fastify({ logger });
  const apiToken = options.apiToken ?? process.env.RUNNER_API_TOKEN;
  const deploymentApiToken = options.deploymentApiToken ?? process.env.DEPLOYMENT_API_TOKEN;
  const appPasswordHash = options.appPasswordHash ?? process.env.APP_PASSWORD_HASH;
  const appSessionSecret = options.appSessionSecret ?? process.env.APP_SESSION_SECRET;
  const appTokenTtlSeconds = options.appTokenTtlSeconds ?? Number(process.env.APP_TOKEN_TTL_SECONDS ?? 900);
  const appOrigins = new Set(options.appOrigins ?? (process.env.APP_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  const now = options.now ?? Date.now;
  const loginRateWindowMs = options.loginRateWindowMs ?? 60_000;
  const loginLimiter = new LoginRateLimiter(options.loginRateLimit, loginRateWindowMs, now);
  const workspaceRoot = options.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? process.cwd();
  const store = new Store(options.databasePath ?? process.env.DATABASE_PATH ?? './data/command-center.sqlite');
  const runsRoot = options.runsRoot ?? process.env.RUNS_ROOT ?? './data/runs';
  const deploymentCoordinator = new DeploymentCoordinator(store, options.backendDeployRepositoryPath ?? process.env.BACKEND_DEPLOY_REPOSITORY_PATH, options.deploymentStarter ?? systemdDeploymentStarter());
  const promotion = new PromotionService(store, workspaceRoot, isAbsolute(runsRoot) ? runsRoot : resolve(process.cwd(), runsRoot), deploymentCoordinator);
  const bus = new JobEventBus();
  const allowMockAgent = options.allowMockAgent ?? process.env.NODE_ENV === 'test';
  const worker = new JobWorker(store, bus, {
    ...(allowMockAgent ? { mock: new MockAgentAdapter(options.mockStepDelayMs) } : {}),
    codex: new CodexAgentAdapter({
      codexBin: options.codexBin ?? process.env.CODEX_BIN ?? 'codex',
      runsRoot,
      workspaceRoot,
      timeoutMs: options.jobTimeoutMs ?? Number(process.env.JOB_TIMEOUT_MS ?? 1_800_000),
      killGraceMs: options.jobKillGraceMs ?? Number(process.env.JOB_KILL_GRACE_MS ?? 5_000),
      log: app.log,
    }),
    claude: new ClaudeAgentAdapter({
      claudeBin: options.claudeBin ?? process.env.CLAUDE_BIN ?? 'claude',
      model: options.claudeModel ?? process.env.CLAUDE_MODEL ?? 'sonnet',
      runsRoot,
      workspaceRoot,
      timeoutMs: options.jobTimeoutMs ?? Number(process.env.JOB_TIMEOUT_MS ?? 1_800_000),
      killGraceMs: options.jobKillGraceMs ?? Number(process.env.JOB_KILL_GRACE_MS ?? 5_000),
      log: app.log,
    }),
  }, app.log, 25, undefined, (jobId) => promotion.applyEffectivePolicies(jobId));

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin) {
      if (!appOrigins.has(origin)) return reply.code(403).send({ error: 'Origin not allowed' });
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin').header('Access-Control-Expose-Headers', 'Content-Type');
    }
    if (request.method === 'OPTIONS') {
      if (!origin) return reply.code(400).send({ error: 'Origin required' });
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS').header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID').header('Access-Control-Max-Age', '600');
      return reply.code(204).send();
    }
    if (request.url === '/health' || request.url === '/auth/login') return;
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (request.url.startsWith('/internal/deployments/')) {
      if (deploymentApiToken && bearer === deploymentApiToken) return;
      return reply.code(deploymentApiToken ? 401 : 503).send({ error: deploymentApiToken ? 'Unauthorized' : 'Deployment authentication is not configured' });
    }
    if ((apiToken && bearer === apiToken) || (appSessionSecret && bearer && verifyAccessToken(bearer, appSessionSecret, now()))) return;
    if (!apiToken && !appSessionSecret) return reply.code(503).send({ error: 'Authentication is not configured' });
    return reply.code(401).send({ error: 'Unauthorized' });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'Validation failed', issues: error.issues });
    if (error instanceof PromotionConflictError) return reply.code(error.code === 'not_found' ? 404 : 409).send({ error: error.message, code: error.code });
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(400).send({ error: 'Repository path does not exist' });
    if (error instanceof Error && error.message.includes('WORKSPACE_ROOT')) return reply.code(400).send({ error: error.message });
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) return reply.code(409).send({ error: 'Resource conflicts with existing data' });
    app.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: 'Internal server error' });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/auth/login', async (request, reply) => {
    if (!appPasswordHash || !appSessionSecret || !Number.isInteger(appTokenTtlSeconds) || appTokenTtlSeconds < 1) return reply.code(503).send({ error: 'App authentication is not configured' });
    const key = request.ip;
    if (!loginLimiter.consume(key)) return reply.header('Retry-After', String(Math.ceil(loginRateWindowMs / 1000))).code(429).send({ error: 'Too many login attempts' });
    const body = request.body as { password?: unknown } | null;
    if (!body || typeof body.password !== 'string' || !(await verifyPassword(body.password, appPasswordHash))) return reply.code(401).send({ error: 'Invalid credentials' });
    return issueAccessToken(appSessionSecret, appTokenTtlSeconds, now());
  });
  app.post('/projects', async (request, reply) => {
    const input = createProjectSchema.parse(request.body);
    const repositories = input.repositories.map((repository) => ({ ...repository, path: validatedRepositoryPath(repository.path, workspaceRoot) }));
    return reply.code(201).send(store.createProject(input.name, repositories));
  });
  app.get('/projects', async () => store.listProjects());
  app.get('/projects/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const project = store.getProject(id);
    return project ?? reply.code(404).send({ error: 'Project not found' });
  });
  app.get('/projects/:id/promotion-policy', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const project = store.getProject(id);
    return project ? { projectId: id, promotionPolicy: project.promotionPolicy, repositories: project.repositories.map(({ id: repositoryId, name, promotionPolicyOverride, effectivePromotionPolicy }) => ({ repositoryId, name, promotionPolicyOverride: promotionPolicyOverride ?? null, effectivePromotionPolicy })) } : reply.code(404).send({ error: 'Project not found' });
  });
  app.put('/projects/:id/promotion-policy', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const { promotionPolicy } = updateProjectPromotionPolicySchema.parse(request.body);
    const project = store.updateProjectPromotionPolicy(id, promotionPolicy); return project ?? reply.code(404).send({ error: 'Project not found' });
  });
  app.put('/projects/:id/repositories/:repositoryId/promotion-policy', async (request, reply) => {
    const { id, repositoryId } = projectRepositoryParamsSchema.parse(request.params); const { promotionPolicyOverride } = updateRepositoryPromotionPolicySchema.parse(request.body);
    const project = store.updateRepositoryPromotionPolicy(id, repositoryId, promotionPolicyOverride); return project ?? reply.code(404).send({ error: 'Project or repository not found' });
  });

  app.post('/jobs', async (request, reply) => {
    const input = createJobSchema.parse(request.body);
    const project = store.getProject(input.projectId); if (!project) return reply.code(404).send({ error: 'Project not found' });
    const requested = input.requestedRepositoryIds ?? input.selectedRepositoryIds ?? [];
    if (requested.length && !store.repositoriesBelongTo(input.projectId, requested)) return reply.code(400).send({ error: 'Every requested repository must belong to the project' });
    const agent = input.agent ?? (process.env.NODE_ENV === 'test' ? 'mock' : 'codex');
    if (agent === 'mock' && !allowMockAgent) return reply.code(400).send({ error: 'Mock agents are available only in automated tests' });
    const legacySelection = request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body)
      && !('scopeMode' in request.body) && 'selectedRepositoryIds' in request.body;
    const job = store.createJob(input.projectId, input.prompt, requested, agent, legacySelection ? 'manual' : input.scopeMode); worker.wake();
    return reply.code(201).send(job);
  });
  app.post('/jobs/:id/scope-decision', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const { decision, requestedRepositoryIds } = scopeDecisionSchema.parse(request.body);
    if (!store.getJob(id)) return reply.code(404).send({ error: 'Job not found' });
    const job = store.decideScope(id, decision === 'approve', decision === 'choose' ? requestedRepositoryIds : undefined);
    if (!job) return reply.code(409).send({ error: 'Job is not waiting for a scope decision' });
    const decisionMessage = decision === 'approve' ? 'Suggested scope approved' : decision === 'choose' ? 'Repository scope corrected manually' : 'Keeping current repository scope';
    bus.publish(store.addEvent(id, 'scope_decision', decisionMessage, { decision, resolvedRepositoryIds: job.resolvedRepositoryIds }));
    worker.wake(); return job;
  });
  app.get('/jobs', async (request) => {
    const query = request.query as { projectId?: string };
    return store.listJobs(query.projectId);
  });
  app.get('/jobs/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const job = store.getJob(id);
    return job ?? reply.code(404).send({ error: 'Job not found' });
  });
  app.get('/jobs/:id/changes', async (request) => promotion.review(idParamsSchema.parse(request.params).id));
  app.post('/jobs/:id/promotions', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const input = promoteJobSchema.parse(request.body);
    const result = await promotion.promote(id, input.commitMessage, input.approvedRepositoryIds);
    return reply.code(result.status === 'promoted' ? 200 : 409).send(result);
  });
  app.get('/jobs/:id/deployments', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    if (!store.getJob(id)) return reply.code(404).send({ error: 'Job not found' });
    return store.deploymentsForJob(id);
  });
  app.get('/deployments/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const deployment = store.getDeployment(id);
    return deployment ?? reply.code(404).send({ error: 'Deployment not found' });
  });
  app.post('/internal/deployments/:id/claim', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const deployment = store.claimDeployment(id);
    return deployment ?? reply.code(409).send({ error: 'Deployment is not queued' });
  });
  app.post('/internal/deployments/:id/state', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = request.body as { status?: unknown; stage?: unknown; errorCode?: unknown } | null;
    if (!body || !DEPLOYMENT_STATUSES.includes(body.status as never) || typeof body.stage !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(body.stage) || (body.errorCode !== undefined && (typeof body.errorCode !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(body.errorCode)))) return reply.code(400).send({ error: 'Invalid deployment state' });
    if (body.status === 'queued') return reply.code(400).send({ error: 'A deployment cannot return to queued' });
    return store.updateDeployment(id, body.status as typeof DEPLOYMENT_STATUSES[number], body.stage, body.errorCode as string | undefined) ?? reply.code(409).send({ error: 'Deployment is terminal or missing' });
  });
  app.get('/jobs/:id/conversation', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const conversation = store.conversation(id);
    return conversation ?? reply.code(404).send({ error: 'Job not found' });
  });
  const continueJob = async (request: any, reply: any) => {
    const { id } = idParamsSchema.parse(request.params); const input = followUpSchema.parse(request.body);
    const result = store.createFollowUp(id, input.message, input.requestId, input.scopeMode, input.requestedRepositoryIds);
    if (result.conflict === 'not_found') return reply.code(404).send({ error: 'Job not found' });
    if (result.conflict === 'parent_active') return reply.code(409).send({ error: 'Only terminal jobs can be continued' });
    if (result.conflict === 'not_latest') return reply.code(409).send({ error: 'Only the latest job in a conversation can be continued' });
    if (result.conflict === 'thread_active') return reply.code(409).send({ error: 'This conversation already has an active job' });
    if (result.conflict === 'scope_invalid') return reply.code(409).send({ error: 'The original repository scope is no longer valid' });
    worker.wake(); return reply.code(201).send(result.job);
  };
  app.post('/jobs/:id/follow-ups', continueJob);
  app.post('/jobs/:id/continue', continueJob);
  app.post('/jobs/:id/cancel', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    if (!store.getJob(id)) return reply.code(404).send({ error: 'Job not found' });
    if (!worker.cancel(id)) return reply.code(409).send({ error: 'Job cannot be cancelled in its current state' });
    return store.getJob(id);
  });
  app.post('/jobs/:id/reply', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const input = replySchema.parse(request.body); const job = store.getJob(id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.status !== 'needs_input') return reply.code(409).send({ error: 'Job is not waiting for input' });
    bus.publish(store.addEvent(id, 'reply', input.message));
    store.setStatus(id, 'queued'); bus.publish(store.addEvent(id, 'status', 'Reply received; job re-queued', { status: 'queued' })); worker.wake();
    return store.getJob(id);
  });
  app.get('/jobs/:id/events', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    if (!store.getJob(id)) return reply.code(404).send({ error: 'Job not found' });
    const rawLastId = request.headers['last-event-id'];
    const after = typeof rawLastId === 'string' && /^\d+$/.test(rawLastId) ? Number(rawLastId) : 0;
    reply.hijack();
    const origin = request.headers.origin;
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'Content-Type' } : {}) });
    const cleanup = () => { clearInterval(heartbeat); bus.off(id, listener); };
    const write = (event: ReturnType<Store['addEvent']>) => {
      reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const status = (event.data as { status?: string } | null)?.status;
      if (['done', 'failed', 'cancelled'].includes(status ?? '')) { cleanup(); reply.raw.end(); }
    };
    const listener = (event: ReturnType<Store['addEvent']>) => write(event);
    bus.on(id, listener);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    for (const event of store.events(id, after)) { write(event); if (reply.raw.writableEnded) break; }
    request.raw.on('close', cleanup);
  });

  app.addHook('onClose', async () => { await worker.stop(); store.close(); });
  worker.start();
  return { app, store, worker };
}
