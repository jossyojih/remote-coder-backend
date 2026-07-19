import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { Store } from './database.js';
import { createJobSchema, createProjectSchema, idParamsSchema, replySchema } from './schemas.js';
import { JobEventBus, JobWorker, MockAgentAdapter } from './worker.js';

export interface AppOptions {
  databasePath?: string;
  workspaceRoot?: string;
  apiToken?: string;
  frontendOrigin?: string;
  logger?: boolean;
  mockStepDelayMs?: number;
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
  const app = Fastify({ logger: options.logger ?? false });
  const apiToken = options.apiToken ?? process.env.RUNNER_API_TOKEN;
  const workspaceRoot = options.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? process.cwd();
  const store = new Store(options.databasePath ?? process.env.DATABASE_PATH ?? './data/command-center.sqlite');
  const bus = new JobEventBus();
  const worker = new JobWorker(store, bus, new MockAgentAdapter(options.mockStepDelayMs), app.log);

  await app.register(cors, { origin: options.frontendOrigin ?? process.env.FRONTEND_ORIGIN ?? false });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    if (!apiToken) return reply.code(503).send({ error: 'RUNNER_API_TOKEN is not configured' });
    if (request.headers.authorization !== `Bearer ${apiToken}`) return reply.code(401).send({ error: 'Unauthorized' });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'Validation failed', issues: error.issues });
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(400).send({ error: 'Repository path does not exist' });
    if (error instanceof Error && error.message.includes('WORKSPACE_ROOT')) return reply.code(400).send({ error: error.message });
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) return reply.code(409).send({ error: 'Resource conflicts with existing data' });
    app.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: 'Internal server error' });
  });

  app.get('/health', async () => ({ status: 'ok' }));
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

  app.post('/jobs', async (request, reply) => {
    const input = createJobSchema.parse(request.body);
    if (!store.getProject(input.projectId)) return reply.code(404).send({ error: 'Project not found' });
    if (!store.repositoriesBelongTo(input.projectId, input.selectedRepositoryIds)) return reply.code(400).send({ error: 'Every selected repository must belong to the project' });
    const job = store.createJob(input.projectId, input.prompt, input.selectedRepositoryIds); worker.wake();
    return reply.code(201).send(job);
  });
  app.get('/jobs', async (request) => {
    const query = request.query as { projectId?: string };
    return store.listJobs(query.projectId);
  });
  app.get('/jobs/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params); const job = store.getJob(id);
    return job ?? reply.code(404).send({ error: 'Job not found' });
  });
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
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
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
