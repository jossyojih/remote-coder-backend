import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { Store } from '../src/database.js';
import { RepositoryScopePlanner } from '../src/scope-planner.js';
import { JobEventBus, JobWorker } from '../src/worker.js';

const apps: FastifyInstance[] = [];
const headers = { authorization: 'Bearer scope-test' };
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function setup(delay = 5) {
  const root = mkdtempSync(join(tmpdir(), 'scope-selection-'));
  mkdirSync(join(root, 'frontend')); mkdirSync(join(root, 'backend'));
  const built = await buildApp({ databasePath: join(root, 'db.sqlite'), workspaceRoot: root, apiToken: 'scope-test', mockStepDelayMs: delay, allowMockAgent: true });
  apps.push(built.app);
  const response = await built.app.inject({ method: 'POST', url: '/projects', headers, payload: { name: 'Product', repositories: [{ name: 'Frontend', path: join(root, 'frontend') }, { name: 'Backend', path: join(root, 'backend') }] } });
  return { ...built, root, project: response.json() };
}

async function waitFor(app: FastifyInstance, id: string, statuses: string[]) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = (await app.inject({ url: `/jobs/${id}`, headers })).json();
    if (statuses.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${id} did not reach ${statuses.join(', ')}`);
}

test('planner resolves the minimum single repository and one broad multi-repository scope', () => {
  const repositories = [
    { id: 'front', projectId: 'p', name: 'Frontend', path: '/workspace/frontend', createdAt: '' },
    { id: 'back', projectId: 'p', name: 'Backend', path: '/workspace/backend', createdAt: '' },
  ];
  const planner = new RepositoryScopePlanner();
  assert.deepEqual(planner.plan('Fix the frontend navigation', repositories).repositoryIds, ['front']);
  assert.deepEqual(planner.plan('Implement this end-to-end across frontend and backend', repositories).repositoryIds, ['front', 'back']);
});

test('planner recognizes repository roles from current bounded manifests without repository-name rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-fingerprint-')); const one = join(root, 'one'); const two = join(root, 'two');
  mkdirSync(one); mkdirSync(two);
  writeFileSync(join(one, 'package.json'), JSON.stringify({ dependencies: { react: '1', vite: '1' } }));
  writeFileSync(join(two, 'package.json'), JSON.stringify({ dependencies: { fastify: '1', 'better-sqlite3': '1' } }));
  const repositories = [{ id: 'one', projectId: 'p', name: 'One', path: one, createdAt: '' }, { id: 'two', projectId: 'p', name: 'Two', path: two, createdAt: '' }];
  const planner = new RepositoryScopePlanner();
  assert.deepEqual(planner.plan('Update the Vite route and React UI', repositories).repositoryIds, ['one']);
  assert.deepEqual(planner.plan('Change the Fastify API database worker', repositories).repositoryIds, ['two']);
  assert.deepEqual(planner.plan('Update the UI but do not modify backend', repositories).repositoryIds, ['one']);
});

test('auto, manual sufficient, and all modes persist requested and resolved scopes', async () => {
  const { app, project } = await setup();
  const frontend = project.repositories.find((repository: { name: string }) => repository.name === 'Frontend');
  const backend = project.repositories.find((repository: { name: string }) => repository.name === 'Backend');
  const cases = [
    { scopeMode: 'auto', prompt: 'Fix frontend navigation', requestedRepositoryIds: [], expected: [frontend.id] },
    { scopeMode: 'manual', prompt: 'Fix frontend navigation', requestedRepositoryIds: [frontend.id], expected: [frontend.id] },
    { scopeMode: 'all', prompt: 'Run maintenance', requestedRepositoryIds: [], expected: project.repositories.map((repository: { id: string }) => repository.id) },
  ];
  for (const item of cases) {
    const created = (await app.inject({ method: 'POST', url: '/jobs', headers, payload: { projectId: project.id, agent: 'mock', ...item } })).json();
    const done = await waitFor(app, created.id, ['done']);
    assert.deepEqual(done.requestedRepositoryIds, item.requestedRepositoryIds);
    assert.deepEqual(done.resolvedRepositoryIds, item.expected);
    assert.equal(done.scopeReasons.length, item.expected.length);
  }
});

test('manual scope is an exact boundary and never proposes another repository', async () => {
  const { app, project, store } = await setup();
  const frontend = project.repositories.find((repository: { name: string }) => repository.name === 'Frontend');
  const created = (await app.inject({ method: 'POST', url: '/jobs', headers, payload: { projectId: project.id, prompt: 'Change the backend API, but do not modify backend', scopeMode: 'manual', requestedRepositoryIds: [frontend.id], agent: 'mock' } })).json();
  const done = await waitFor(app, created.id, ['done']);
  assert.deepEqual(done.requestedRepositoryIds, [frontend.id]);
  assert.deepEqual(done.resolvedRepositoryIds, [frontend.id]);
  assert.deepEqual(done.selectedRepositoryIds, [frontend.id]);
  assert.equal(done.proposedRepositoryIds, undefined);
  assert.equal(done.scopeReasons[0].reason, 'Explicitly selected for manual scope.');
  const eventTypes = store.events(created.id).map((event) => event.type);
  assert.equal(eventTypes.includes('scope_proposal'), false);
});

test('legacy selectedRepositoryIds remains strict manual scope', async () => {
  const { app, project } = await setup();
  const frontend = project.repositories.find((repository: { name: string }) => repository.name === 'Frontend');
  const created = (await app.inject({ method: 'POST', url: '/jobs', headers, payload: { projectId: project.id, prompt: 'Change the backend API', selectedRepositoryIds: [frontend.id], agent: 'mock' } })).json();
  assert.equal(created.scopeMode, 'manual');
  const done = await waitFor(app, created.id, ['done']);
  assert.deepEqual(done.resolvedRepositoryIds, [frontend.id]);
  assert.equal(done.proposedRepositoryIds, undefined);
});

test('resolved planning state survives running-job recovery without resetting scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-recovery-')); const path = join(root, 'db.sqlite'); mkdirSync(join(root, 'repo'));
  let store = new Store(path); const project = store.createProject('P', [{ name: 'Repo', path: join(root, 'repo') }]);
  const job = store.createJob(project.id, 'Work', [], 'codex', 'auto');
  store.resolveScope(job.id, [project.repositories[0].id], [{ repositoryId: project.repositories[0].id, reason: 'Required.' }]);
  store.setStatus(job.id, 'running'); store.close(); store = new Store(path);
  assert.equal(store.getJob(job.id)?.status, 'queued');
  assert.equal(store.scopeState(job.id), 'resolved');
  assert.deepEqual(store.getJob(job.id)?.resolvedRepositoryIds, [project.repositories[0].id]);
  store.close();
});

test('auto structured insufficient-scope results request approval without silently expanding access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-required-')); mkdirSync(join(root, 'one')); mkdirSync(join(root, 'two'));
  const store = new Store(join(root, 'db.sqlite')); const project = store.createProject('P', [{ name: 'One', path: join(root, 'one') }, { name: 'Two', path: join(root, 'two') }]);
  const job = store.createJob(project.id, 'Work', [], 'mock', 'auto');
  store.resolveScope(job.id, [project.repositories[0].id], [{ repositoryId: project.repositories[0].id, reason: 'Selected.' }]);
  const worker = new JobWorker(store, new JobEventBus(), { mock: { async run(_job, _repositories, emit) { emit('scope_required', 'Need another repository', { suggestedRepositoryIds: [project.repositories[1].id], reasons: [{ repositoryId: project.repositories[1].id, reason: 'The API implementation is located there.' }] }); } } }, { error() {} } as any, 5);
  worker.start();
  for (let attempt = 0; attempt < 100 && store.getJob(job.id)?.status !== 'needs_input'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.getJob(job.id)?.status, 'needs_input');
  assert.deepEqual(store.getJob(job.id)?.resolvedRepositoryIds, [project.repositories[0].id]);
  assert.deepEqual(store.getJob(job.id)?.proposedRepositoryIds, [project.repositories[1].id]);
  await worker.stop();
  const corrected = store.decideScope(job.id, true);
  assert.deepEqual(corrected?.resolvedRepositoryIds, [project.repositories[1].id]);
  store.close();
});

test('manual structured insufficient-scope results cannot propose or add a repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-required-manual-')); mkdirSync(join(root, 'one')); mkdirSync(join(root, 'two'));
  const store = new Store(join(root, 'db.sqlite')); const project = store.createProject('P', [{ name: 'One', path: join(root, 'one') }, { name: 'Two', path: join(root, 'two') }]);
  const selected = project.repositories[0]; const other = project.repositories[1];
  const job = store.createJob(project.id, 'Work', [selected.id], 'mock', 'manual');
  let candidates: string[] = [];
  const worker = new JobWorker(store, new JobEventBus(), { mock: { async run(current, repositories, emit) {
    candidates = current.repositoryScopeCandidates?.map((candidate) => candidate.repositoryId) ?? [];
    assert.deepEqual(repositories.map((repository) => repository.id), [selected.id]);
    emit('scope_required', 'Need another repository', { suggestedRepositoryIds: [other.id], reasons: [{ repositoryId: other.id, reason: 'Located there.' }] });
  } } }, { error() {} } as any, 5);
  worker.start();
  for (let attempt = 0; attempt < 100 && store.getJob(job.id)?.status !== 'done'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.getJob(job.id)?.status, 'done');
  assert.deepEqual(store.getJob(job.id)?.resolvedRepositoryIds, [selected.id]);
  assert.equal(store.getJob(job.id)?.proposedRepositoryIds, undefined);
  assert.deepEqual(candidates, [selected.id]);
  assert.equal(store.events(job.id).some((event) => event.type === 'scope_required'), false);
  await worker.stop(); store.close();
});
