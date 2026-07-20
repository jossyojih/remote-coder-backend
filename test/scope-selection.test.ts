import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { Store } from '../src/database.js';
import { RepositoryScopePlanner } from '../src/scope-planner.js';

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

test('manual expansion requires explicit approval or rejection', async () => {
  const { app, project } = await setup();
  const frontend = project.repositories.find((repository: { name: string }) => repository.name === 'Frontend');
  const backend = project.repositories.find((repository: { name: string }) => repository.name === 'Backend');
  for (const decision of ['approve', 'reject'] as const) {
    const created = (await app.inject({ method: 'POST', url: '/jobs', headers, payload: { projectId: project.id, prompt: 'Change the backend API', scopeMode: 'manual', requestedRepositoryIds: [frontend.id], agent: 'mock' } })).json();
    const waiting = await waitFor(app, created.id, ['needs_input']);
    assert.deepEqual(waiting.proposedRepositoryIds, [backend.id]);
    assert.deepEqual(waiting.resolvedRepositoryIds, []);
    const response = await app.inject({ method: 'POST', url: `/jobs/${created.id}/scope-decision`, headers, payload: { decision } });
    assert.equal(response.statusCode, 200);
    const done = await waitFor(app, created.id, ['done']);
    assert.deepEqual(done.resolvedRepositoryIds, decision === 'approve' ? [frontend.id, backend.id] : [frontend.id]);
  }
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
