import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { Store } from './database.js';
import { CodexAgentAdapter } from './codex-adapter.js';
import { ClaudeAgentAdapter } from './claude-adapter.js';
import { addRepositorySchema, createJobSchema, createProjectSchema, disconnectRepositorySchema, followUpSchema, idParamsSchema, projectRepositoryParamsSchema, promoteJobSchema, replySchema, scopeDecisionSchema, threadSearchSchema, updateProjectAgentDefaultsSchema, updateProjectPromotionPolicySchema, updateProjectSchema, updateRepositoryPromotionPolicySchema } from './schemas.js';
import { cloneRepository, cleanupFailedClone, extractGitHubUrlFromOrigin, parseGitHubUrl, safeDirName, validateRepositoryUrl } from './repository-onboarding.js';
import { buildCapabilities, validateSelection } from './capabilities.js';
import { JobEventBus, JobWorker, MockAgentAdapter } from './worker.js';
import { issueAccessToken, LoginRateLimiter, verifyAccessToken, verifyPassword } from './auth.js';
import { PromotionConflictError, PromotionService } from './promotion.js';
import { DeploymentCoordinator, systemdDeploymentStarter, type DeploymentStarter } from './deployment.js';
import { DEPLOYMENT_STATUSES } from './types.js';
import { MaintenanceService } from './maintenance.js';
import { AttachmentStorage, ATTACHMENT_LIMITS } from './attachments.js';
import { GitHubAppAuth } from './github-app.js';

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
  codexModels?: string;
  codexDefaultModel?: string;
  codexReasoningLevels?: string;
  codexDefaultReasoning?: string;
  claudeModels?: string;
  claudeReasoningLevels?: string;
  claudeDefaultReasoning?: string;
  defaultAgent?: string;
  runsRoot?: string;
  jobTimeoutMs?: number;
  jobKillGraceMs?: number;
  allowMockAgent?: boolean;
  backendDeployRepositoryPath?: string;
  deploymentApiToken?: string;
  deploymentStarter?: DeploymentStarter;
  maintenanceIntervalMs?: number;
  maintenanceStartupDelayMs?: number;
  maintenanceRunOverride?: () => Promise<void>;
  terminalGracePeriodMs?: number;
  failedRetentionMs?: number;
  diskWarningThreshold?: number;
  cleanupBatchLimit?: number;
  maintenanceCleanupEnabled?: boolean;
  attachmentsRoot?: string;
}

export interface CommandCenterApp {
  app: FastifyInstance;
  store: Store;
  worker: JobWorker;
  maintenance: MaintenanceService;
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
  await app.register(multipart, {
    limits: { fileSize: ATTACHMENT_LIMITS.maxFileSize, files: ATTACHMENT_LIMITS.maxFilesPerJob },
  });
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
  const absoluteRunsRoot = isAbsolute(runsRoot) ? runsRoot : resolve(process.cwd(), runsRoot);
  const attachmentsRoot = options.attachmentsRoot ?? process.env.ATTACHMENTS_ROOT ?? resolve(process.cwd(), './data/attachments');
  const attachments = new AttachmentStorage(attachmentsRoot);
  const githubApp = new GitHubAppAuth();
  const deploymentCoordinator = new DeploymentCoordinator(store, options.backendDeployRepositoryPath ?? process.env.BACKEND_DEPLOY_REPOSITORY_PATH, options.deploymentStarter ?? systemdDeploymentStarter());
  const promotion = new PromotionService(store, workspaceRoot, absoluteRunsRoot, deploymentCoordinator);
  const bus = new JobEventBus();
  const allowMockAgent = options.allowMockAgent ?? process.env.NODE_ENV === 'test';
  const capabilities = buildCapabilities({
    codexModels: options.codexModels ?? process.env.CODEX_MODELS,
    codexDefaultModel: options.codexDefaultModel ?? process.env.CODEX_MODEL,
    codexReasoningLevels: options.codexReasoningLevels ?? process.env.CODEX_REASONING_LEVELS,
    codexDefaultReasoning: options.codexDefaultReasoning ?? process.env.CODEX_REASONING_EFFORT,
    claudeModels: options.claudeModels ?? process.env.CLAUDE_MODELS,
    claudeDefaultModel: options.claudeModel ?? process.env.CLAUDE_MODEL,
    claudeReasoningLevels: options.claudeReasoningLevels ?? process.env.CLAUDE_REASONING_LEVELS,
    claudeDefaultReasoning: options.claudeDefaultReasoning ?? process.env.CLAUDE_REASONING_EFFORT,
    defaultAgent: options.defaultAgent ?? process.env.DEFAULT_AGENT ?? (process.env.NODE_ENV === 'test' ? 'mock' : 'codex'), allowMock: allowMockAgent,
  });
  const codexCapability = capabilities.agents.find((agent) => agent.id === 'codex')!;
  const claudeCapability = capabilities.agents.find((agent) => agent.id === 'claude')!;
  store.normalizeLegacySelections({ codexModel: codexCapability.defaults.model, codexReasoning: codexCapability.defaults.reasoningLevel!, claudeModel: claudeCapability.defaults.model });
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
  }, app.log, 25, undefined, (jobId) => promotion.applyEffectivePolicies(jobId), attachments);

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
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ error: error instanceof Error ? error.message : 'Bad request' });
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
  const onboardingLocks = new Map<string, Promise<unknown>>();

  app.post('/projects', async (request, reply) => {
    const input = createProjectSchema.parse(request.body);
    const repositories: Array<{ name: string; path: string; remoteName?: string; targetBranch?: string; normalizedUrl?: string }> = [];
    for (const repository of input.repositories) {
      repositories.push({ ...repository, path: validatedRepositoryPath(repository.path, workspaceRoot) });
    }
    for (const repoUrl of input.repositoryUrls ?? []) {
      const validation = validateRepositoryUrl(repoUrl.url);
      if (!validation.valid) return reply.code(400).send({ error: validation.error });
      const existing = store.findRepositoryByNormalizedUrl(validation.normalized);
      if (existing) return reply.code(409).send({ error: `Repository ${validation.owner}/${validation.repo} is already onboarded` });
      const dirName = safeDirName(validation.owner, validation.repo);
      const result = cloneRepository(validation.normalized, dirName, workspaceRoot);
      repositories.push({
        name: repoUrl.name || `${validation.owner}/${validation.repo}`,
        path: result.clonePath,
        targetBranch: result.defaultBranch,
        normalizedUrl: validation.normalized,
      });
    }
    for (const ghRepo of input.githubRepositories ?? []) {
      if (!githubApp.isConfigured()) return reply.code(503).send({ error: 'GitHub App is not configured' });
      const normalized = `git@github.com:${ghRepo.owner}/${ghRepo.repo}.git`;
      const existing = store.findRepositoryByNormalizedUrl(normalized);
      if (existing) return reply.code(409).send({ error: `Repository ${ghRepo.owner}/${ghRepo.repo} is already onboarded` });
      try {
        const hasAccess = await githubApp.verifyRepositoryAccess(ghRepo.owner, ghRepo.repo);
        if (!hasAccess) return reply.code(403).send({ error: `GitHub App does not have access to ${ghRepo.owner}/${ghRepo.repo}` });
        const token = await githubApp.getInstallationToken();
        const dirName = safeDirName(ghRepo.owner, ghRepo.repo);
        const result = cloneRepository(normalized, dirName, workspaceRoot, { token });
        repositories.push({
          name: ghRepo.name || `${ghRepo.owner}/${ghRepo.repo}`,
          path: result.clonePath,
          targetBranch: ghRepo.defaultBranch || result.defaultBranch,
          normalizedUrl: normalized,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Repository onboarding failed';
        return reply.code(400).send({ error: message });
      }
    }
    const project = store.createProject(input.name, repositories, input.description, input.promotionPolicy, input.defaultAgent, input.defaultModel);
    return reply.code(201).send(project);
  });
  app.put('/projects/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = updateProjectSchema.parse(request.body);
    const project = store.updateProject(id, input);
    return project ?? reply.code(404).send({ error: 'Project not found' });
  });
  app.get('/projects', async () => store.listProjects(extractGitHubUrlFromOrigin));
  app.post('/projects/:id/repositories', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const project = store.getProject(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    const input = addRepositorySchema.parse(request.body);
    const activeJobs = store.activeJobsForProject(id);
    if (activeJobs.length > 0) return reply.code(409).send({ error: 'Cannot add repositories while jobs are active' });

    let normalized: string;
    let owner: string;
    let repo: string;
    let dirName: string;
    let cloneOptions: { token?: string } | undefined;
    let targetBranch: string | undefined;

    if (input.url) {
      const validation = validateRepositoryUrl(input.url);
      if (!validation.valid) return reply.code(400).send({ error: validation.error });
      normalized = validation.normalized;
      owner = validation.owner;
      repo = validation.repo;
    } else if (input.owner && input.repo) {
      if (!githubApp.isConfigured()) return reply.code(503).send({ error: 'GitHub App is not configured' });
      owner = input.owner;
      repo = input.repo;
      normalized = `git@github.com:${owner}/${repo}.git`;
      try {
        const hasAccess = await githubApp.verifyRepositoryAccess(owner, repo);
        if (!hasAccess) return reply.code(403).send({ error: `GitHub App does not have access to ${owner}/${repo}` });
        const token = await githubApp.getInstallationToken();
        cloneOptions = { token };
        targetBranch = input.defaultBranch;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'GitHub App verification failed';
        return reply.code(400).send({ error: message });
      }
    } else {
      return reply.code(400).send({ error: 'Either url or owner+repo is required' });
    }

    const githubUrl = `https://github.com/${owner}/${repo}`;
    const lockKey = `${id}:${githubUrl}`;
    if (onboardingLocks.has(lockKey)) return reply.code(409).send({ error: 'Repository onboarding already in progress' });
    const existing = store.findRepositoryByNormalizedUrl(githubUrl, id);
    if (existing) return reply.code(409).send({ error: `Repository ${owner}/${repo} is already connected to this project` });

    dirName = safeDirName(owner, repo);
    let onboardPromise: Promise<unknown>;
    try {
      onboardPromise = Promise.resolve();
      onboardingLocks.set(lockKey, onboardPromise);
      const result = cloneRepository(normalized, dirName, workspaceRoot, cloneOptions);
      const name = input.name || `${owner}/${repo}`;
      const repoRecord = store.addRepository(id, name, result.clonePath, 'origin', targetBranch || result.defaultBranch, githubUrl);
      return reply.code(201).send(repoRecord);
    } catch (error) {
      cleanupFailedClone(dirName, workspaceRoot);
      const message = error instanceof Error ? error.message : 'Repository onboarding failed';
      return reply.code(400).send({ error: message });
    } finally {
      onboardingLocks.delete(lockKey);
    }
  });
  app.delete('/projects/:id/repositories/:repositoryId', async (request, reply) => {
    const { id, repositoryId } = projectRepositoryParamsSchema.parse(request.params);
    const input = disconnectRepositorySchema.parse(request.body);
    const project = store.getProject(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    const repo = store.getRepository(repositoryId);
    if (!repo || repo.projectId !== id || repo.disconnectedAt) return reply.code(404).send({ error: 'Repository not found in this project' });
    const expectedName = repo.normalizedUrl
      ? repo.normalizedUrl.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '')
      : repo.name;
    if (input.confirmName !== expectedName) return reply.code(400).send({ error: 'Confirmation name does not match repository' });
    const activeJobs = store.activeJobsForRepository(repositoryId);
    if (activeJobs.length > 0) return reply.code(409).send({ error: 'Cannot disconnect: repository has active jobs', code: 'active_jobs' });
    const pendingPromotions = store.pendingPromotionsForRepository(repositoryId);
    if (pendingPromotions.length > 0) return reply.code(409).send({ error: 'Cannot disconnect: repository has pending promotions', code: 'pending_promotions' });
    const activeDeployments = store.activeDeploymentsForRepository(repositoryId);
    if (activeDeployments.length > 0) return reply.code(409).send({ error: 'Cannot disconnect: repository has active deployments', code: 'active_deployments' });
    const isManaged = !!repo.normalizedUrl;
    let cloneRemoved = false;
    if (isManaged) {
      try {
        const { realpathSync, existsSync, lstatSync, rmSync } = await import('node:fs');
        const { execFileSync } = await import('node:child_process');
        const { relative, isAbsolute } = await import('node:path');
        const root = realpathSync(workspaceRoot);
        if (existsSync(repo.path)) {
          const stat = lstatSync(repo.path);
          if (stat.isSymbolicLink()) {
            return reply.code(400).send({ error: 'Repository path is a symlink' });
          }
        }
        const realPath = existsSync(repo.path) ? realpathSync(repo.path) : repo.path;
        const rel = relative(root, realPath);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          return reply.code(400).send({ error: 'Repository path is outside workspace root' });
        }
        let hasWorktrees = false;
        if (existsSync(realPath)) {
          try {
            const worktreeList = execFileSync('git', ['-C', realPath, 'worktree', 'list', '--porcelain'], { timeout: 10_000, stdio: 'pipe', encoding: 'utf-8' });
            const worktreeLines = worktreeList.split('\n').filter((line) => line.startsWith('worktree '));
            hasWorktrees = worktreeLines.length > 1;
          } catch { /* no worktrees or not a git repo */ }
        }
        if (hasWorktrees) {
          return reply.code(409).send({ error: 'Cannot remove clone: repository has active worktrees', code: 'active_worktrees' });
        }
        store.disconnectRepository(repositoryId);
        if (existsSync(realPath)) {
          rmSync(realPath, { recursive: true, force: true });
        }
        cloneRemoved = true;
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode) throw error;
        store.disconnectRepository(repositoryId);
      }
    } else {
      store.disconnectRepository(repositoryId);
    }
    return { disconnected: true, repositoryId, cloneRemoved };
  });
  app.get('/capabilities', async () => capabilities);
  app.get('/github/status', async () => ({ configured: githubApp.isConfigured() }));
  app.get('/github/repositories', async (request, reply) => {
    if (!githubApp.isConfigured()) return reply.code(503).send({ error: 'GitHub App is not configured' });
    const query = request.query as { page?: string; perPage?: string; search?: string; projectId?: string };
    try {
      const page = query.page ? Math.max(1, parseInt(query.page, 10)) : 1;
      const perPage = query.perPage ? Math.min(100, Math.max(1, parseInt(query.perPage, 10))) : 30;
      const { repositories, totalCount } = await githubApp.listRepositories({ page, perPage, search: query.search });
      const connectedUrls = query.projectId ? new Set(store.getProject(query.projectId)?.repositories.map((r) => r.normalizedUrl) ?? []) : new Set();
      const items = repositories.map((repo) => {
        const githubUrl = `https://github.com/${repo.owner.login}/${repo.name}`;
        return {
          id: repo.id,
          fullName: repo.full_name,
          owner: repo.owner.login,
          name: repo.name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          alreadyConnected: connectedUrls.has(githubUrl),
        };
      });
      return { repositories: items, totalCount, page, perPage };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GitHub API request failed';
      if (message.includes('rate limit')) return reply.code(429).send({ error: 'GitHub API rate limit exceeded' });
      if (message.includes('authentication')) return reply.code(401).send({ error: 'GitHub App authentication failed' });
      return reply.code(502).send({ error: 'GitHub API unavailable' });
    }
  });
  app.get('/projects/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const project = store.getProject(id, extractGitHubUrlFromOrigin);
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
  app.put('/projects/:id/agent-defaults', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const input = updateProjectAgentDefaultsSchema.parse(request.body);
    if (!store.getProject(id)) return reply.code(404).send({ error: 'Project not found' });
    return store.updateProjectAgentDefaults(id, validateSelection(capabilities, input))!;
  });
  app.put('/projects/:id/repositories/:repositoryId/promotion-policy', async (request, reply) => {
    const { id, repositoryId } = projectRepositoryParamsSchema.parse(request.params); const { promotionPolicyOverride } = updateRepositoryPromotionPolicySchema.parse(request.body);
    const project = store.updateRepositoryPromotionPolicy(id, repositoryId, promotionPolicyOverride); return project ?? reply.code(404).send({ error: 'Project or repository not found' });
  });

  app.post('/jobs', async (request, reply) => {
    const input = createJobSchema.parse(request.body);
    const project = store.getProject(input.projectId); if (!project) return reply.code(404).send({ error: 'Project not found' });
    if (project.repositories.length === 0) return reply.code(409).send({ error: 'Project has no repositories. Add at least one repository before creating a job.', code: 'project_has_no_repositories' });
    const requested = input.requestedRepositoryIds ?? input.selectedRepositoryIds ?? [];
    if (requested.length && !store.repositoriesBelongTo(input.projectId, requested)) return reply.code(400).send({ error: 'Every requested repository must belong to the project' });
    const projectDefaults = project.defaultAgent ? { agent: project.defaultAgent, model: project.defaultModel, reasoningLevel: project.defaultReasoningLevel } : undefined;
    const selection = validateSelection(capabilities, input, projectDefaults);
    if (selection.agent === 'mock' && !allowMockAgent) return reply.code(400).send({ error: 'Mock agents are available only in automated tests' });
    const legacySelection = request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body)
      && !('scopeMode' in request.body) && 'selectedRepositoryIds' in request.body;
    const job = store.createJob(input.projectId, input.prompt, requested, selection, legacySelection ? 'manual' : input.scopeMode);
    if (input.attachments) {
      for (const attachment of input.attachments) {
        attachments.promote(attachment.id, input.projectId, job.threadId!);
        store.addAttachment(attachment.id, job.id, job.threadId!, input.projectId, attachment.filename, attachment.mimeType, attachment.sizeBytes);
      }
    }
    worker.wake();
    return reply.code(201).send(job);
  });
  app.post('/jobs/:id/scope-decision', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const { decision, requestedRepositoryIds } = scopeDecisionSchema.parse(request.body);
    if (!store.getJob(id)) return reply.code(404).send({ error: 'Job not found' });
    const repeated = store.hasScopeDecision(id);
    const job = store.decideScope(id, decision === 'approve', decision === 'choose' ? requestedRepositoryIds : undefined);
    if (!job) return reply.code(409).send({ error: 'Job is not waiting for a scope decision' });
    if (!repeated) {
      const decisionMessage = decision === 'approve' ? 'Suggested scope approved' : decision === 'choose' ? 'Repository scope corrected manually' : 'Keeping current repository scope';
      bus.publish(store.addEvent(id, 'scope_decision', decisionMessage, { decision, resolvedRepositoryIds: job.resolvedRepositoryIds }));
      worker.wake();
    }
    return job;
  });
  app.get('/jobs', async (request) => {
    const query = request.query as { projectId?: string };
    return store.listJobs(query.projectId);
  });
  app.get('/threads/search', async (request) => {
    const filters = threadSearchSchema.parse(request.query);
    const { results, total } = store.searchThreads(filters);
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 20));
    return { results, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  });
  app.get('/threads/archived', async () => store.archivedThreads(new Date(now()).toISOString()));
  app.post('/threads/:id/archive', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = (request.body ?? {}) as { confirmActive?: unknown };
    if (body.confirmActive !== undefined && typeof body.confirmActive !== 'boolean') return reply.code(400).send({ error: 'confirmActive must be a boolean' });
    const active = store.threadActiveJobIds(id);
    if (!active) return reply.code(404).send({ error: 'Thread not found' });
    if (active.length && body.confirmActive !== true) return reply.code(409).send({ error: 'Archiving this thread requires confirmation because execution is active', code: 'active_confirmation_required' });
    for (const jobId of active) worker.cancel(jobId);
    const result = store.archiveThread(id, now());
    if (result.conflict === 'active') return reply.code(409).send({ error: 'Active execution could not be cancelled' });
    return result.thread;
  });
  app.post('/threads/:id/restore', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const result = store.restoreThread(id, now());
    if (result.conflict === 'not_found') return reply.code(404).send({ error: 'Thread not found' });
    if (result.conflict === 'expired') return reply.code(410).send({ error: 'The restore grace period has expired' });
    return { threadId: result.threadId };
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
    const parent = store.getJob(id);
    const selection = parent ? validateSelection(capabilities, { agent: parent.agent, model: input.model ?? parent.model, reasoningLevel: input.reasoningLevel ?? parent.reasoningLevel }) : undefined;
    const result = store.createFollowUp(id, input.message, input.requestId, input.scopeMode, input.requestedRepositoryIds, selection);
    if (result.conflict === 'not_found') return reply.code(404).send({ error: 'Job not found' });
    if (result.conflict === 'parent_active') return reply.code(409).send({ error: 'Only terminal jobs can be continued' });
    if (result.conflict === 'not_latest') return reply.code(409).send({ error: 'Only the latest job in a conversation can be continued' });
    if (result.conflict === 'thread_active') return reply.code(409).send({ error: 'This conversation already has an active job' });
    if (result.conflict === 'scope_invalid') return reply.code(409).send({ error: 'The original repository scope is no longer valid' });
    if (result.conflict === 'archived') return reply.code(409).send({ error: 'Archived threads cannot be continued' });
    if (result.job && input.attachments) {
      for (const attachment of input.attachments) {
        attachments.promote(attachment.id, result.job.projectId, result.job.threadId!);
        store.addAttachment(attachment.id, result.job.id, result.job.threadId!, result.job.projectId, attachment.filename, attachment.mimeType, attachment.sizeBytes);
      }
    }
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

  app.post('/attachments/upload', async (request, reply) => {
    const parts = request.parts();
    const uploaded: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }> = [];
    let totalSize = 0;
    for await (const part of parts) {
      if (part.type !== 'file') continue;
      if (uploaded.length >= ATTACHMENT_LIMITS.maxFilesPerJob) return reply.code(400).send({ error: `Maximum ${ATTACHMENT_LIMITS.maxFilesPerJob} files per upload` });
      const buffer = await part.toBuffer();
      if (buffer.length > ATTACHMENT_LIMITS.maxFileSize) return reply.code(400).send({ error: `File ${part.filename} exceeds ${ATTACHMENT_LIMITS.maxFileSize / (1024 * 1024)}MB` });
      totalSize += buffer.length;
      if (totalSize > ATTACHMENT_LIMITS.maxTotalSize) return reply.code(400).send({ error: `Total size exceeds ${ATTACHMENT_LIMITS.maxTotalSize / (1024 * 1024)}MB` });
      if (!attachments.validateMimeType(part.mimetype)) return reply.code(400).send({ error: `File type ${part.mimetype} not allowed` });
      if (!attachments.validateExtension(part.filename)) return reply.code(400).send({ error: `File extension not allowed` });
      const id = crypto.randomUUID();
      const staged = attachments.stage(id, part.filename, part.mimetype, buffer);
      uploaded.push(staged);
    }
    return { attachments: uploaded };
  });

  app.get('/attachments/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const meta = store.getAttachmentMeta(id);
    if (!meta) return reply.code(404).send({ error: 'Attachment not found' });
    const job = store.getJob(meta.jobId, true);
    if (!job) return reply.code(404).send({ error: 'Associated job not found' });
    const retrieved = attachments.retrieve(id, meta.projectId, meta.threadId);
    if (!retrieved) return reply.code(404).send({ error: 'Attachment file not found' });
    reply.type(retrieved.meta.mimeType);
    reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(retrieved.meta.filename)}"`);
    reply.header('Content-Length', String(retrieved.content.length));
    return reply.send(retrieved.content);
  });

  app.get('/maintenance/status', async () => {
    const status = maintenance.getStatus();
    return {
      lastRunAt: status.lastRunAt,
      lastRunCompletedAt: status.lastRunCompletedAt,
      nextRunAt: status.nextRunAt,
      cleanupEnabled: status.cleanupEnabled,
      isRunning: status.isRunning,
      eligibleWorktrees: status.eligibleWorktrees,
      protectedWorktrees: status.protectedWorktrees,
      lastCleanedCount: status.lastCleanedCount,
      lastFailedCount: status.lastFailedCount,
      totalReclaimedBytes: status.totalReclaimedBytes,
      retainedWorktreeCount: status.retainedWorktreeCount,
      retainedWorktreeBytes: status.retainedWorktreeBytes,
      diskUsageBytes: status.diskUsageBytes,
      archivedThreads: status.archivedThreads,
      lastPreviewAt: status.lastPreviewAt,
    };
  });

  app.get('/maintenance/preview', async () => {
    const preview = maintenance.getCachedPreview();
    return {
      ...preview,
      eligible: preview.eligible.map(({ worktreePath: _path, ...item }) => item),
      protectedWorktrees: preview.protectedWorktrees.map(({ worktreePath: _path, ...item }) => item),
    };
  });

  app.post('/maintenance/preview', async () => {
    const preview = await maintenance.previewCleanup();
    return {
      retainedWorktreeCount: preview.retainedWorktreeCount,
      classifiedWorktreeCount: preview.classifiedWorktreeCount,
      generatedAt: preview.generatedAt,
      eligible: preview.eligible.map((item) => ({
        jobId: item.jobId,
        repositoryId: item.repositoryId,
        reason: item.reason,
        estimatedBytes: item.estimatedBytes,
      })),
      protectedWorktrees: preview.protectedWorktrees.map((item) => ({
        jobId: item.jobId,
        repositoryId: item.repositoryId,
        reason: item.reason,
      })),
    };
  });

  app.post('/maintenance/cleanup', async (request, reply) => {
    const result = await maintenance.triggerMaintenance();
    if (result.disabled) {
      return reply.code(403).send({ error: 'Maintenance cleanup is disabled by server policy' });
    }
    if (!result.started) {
      return reply.code(409).send({ error: 'Maintenance is already running' });
    }
    return { started: true };
  });

  app.get('/maintenance/history', async () => {
    return {
      cleaned: maintenance.getCleanupHistory(20).map(({ worktreePath: _path, ...item }) => item),
      failed: maintenance.getFailureHistory(20).map(({ worktreePath: _path, ...item }) => item),
    };
  });

  const maintenance = new MaintenanceService(
    store,
    {
      runsRoot: absoluteRunsRoot,
      intervalMs: options.maintenanceIntervalMs ?? Number(process.env.MAINTENANCE_INTERVAL_MS ?? 12 * 60 * 60 * 1000),
      startupDelayMs: options.maintenanceStartupDelayMs ?? Number(process.env.MAINTENANCE_STARTUP_DELAY_MS ?? 10_000),
      terminalGracePeriodMs: options.terminalGracePeriodMs ?? Number(process.env.TERMINAL_GRACE_PERIOD_MS ?? 24 * 60 * 60 * 1000),
      failedRetentionMs: options.failedRetentionMs ?? Number(process.env.FAILED_RETENTION_MS ?? 7 * 24 * 60 * 60 * 1000),
      diskWarningThreshold: options.diskWarningThreshold ?? Number(process.env.DISK_WARNING_THRESHOLD ?? 0.85),
      batchLimit: options.cleanupBatchLimit ?? Number(process.env.CLEANUP_BATCH_LIMIT ?? 50),
      cleanupEnabled: options.maintenanceCleanupEnabled ?? process.env.MAINTENANCE_CLEANUP_ENABLED === 'true',
    },
    app.log,
    attachments,
    now,
    options.maintenanceRunOverride,
  );

  app.addHook('onListen', async () => { maintenance.start(); });
  app.addHook('onClose', async () => { maintenance.stop(); await worker.stop(); store.close(); });
  worker.start();
  return { app, store, worker, maintenance };
}
