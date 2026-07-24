import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { JobEventBus, JobWorker } from '../src/worker.js';

const apps: FastifyInstance[] = [];
const auth = { authorization: 'Bearer thread-scope' };
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thread-scope-'));
  for (const name of ['front', 'back', 'other']) mkdirSync(join(root, name));
  const built = await buildApp({ databasePath: join(root, 'db.sqlite'), workspaceRoot: root, apiToken: 'thread-scope', allowMockAgent: true, mockStepDelayMs: 500 });
  apps.push(built.app);
  const create = async (name: string, paths: string[]) => (await built.app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name, repositories: paths.map((path) => ({ name: path, path: join(root, path) })) },
  })).json();
  return { ...built, project: await create('Product', ['front', 'back']), other: await create('Other', ['other']) };
}

test('approval is inherited by multiple follow-ups and exposed as earlier conversation scope', async () => {
  const { app, store, project } = await fixture();
  const root = (await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId: project.id, prompt: 'front', scopeMode: 'manual', requestedRepositoryIds: [project.repositories[0].id], agent: 'mock' } })).json();
  await app.inject({ method: 'POST', url: `/jobs/${root.id}/cancel`, headers: auth });
  store.proposeScope(root.id, [project.repositories[1].id], [{ repositoryId: project.repositories[1].id, reason: 'Needed.' }]);
  const approved = await app.inject({ method: 'POST', url: `/jobs/${root.id}/scope-decision`, headers: auth, payload: { decision: 'approve' } });
  assert.equal(approved.statusCode, 200);
  await app.inject({ method: 'POST', url: `/jobs/${root.id}/cancel`, headers: auth });
  const first = (await app.inject({ method: 'POST', url: `/jobs/${root.id}/continue`, headers: auth, payload: { message: 'again', requestId: crypto.randomUUID() } })).json();
  assert.deepEqual(new Set(first.resolvedRepositoryIds), new Set(project.repositories.map((repository: { id: string }) => repository.id)));
  assert.ok(first.threadRepositoryPermissions.every((permission: { inherited: boolean }) => permission.inherited));
  await app.inject({ method: 'POST', url: `/jobs/${first.id}/cancel`, headers: auth });
  const second = (await app.inject({ method: 'POST', url: `/jobs/${first.id}/continue`, headers: auth, payload: { message: 'again 2', requestId: crypto.randomUUID() } })).json();
  assert.deepEqual(new Set(second.resolvedRepositoryIds), new Set(project.repositories.map((repository: { id: string }) => repository.id)));
});

test('rejection suppresses repeat requests and decisions are retry/concurrency idempotent', async () => {
  const { app, store, project } = await fixture();
  const job = store.createJob(project.id, 'Work', [project.repositories[0].id], 'mock', 'auto');
  store.resolveScope(job.id, [project.repositories[0].id], [{ repositoryId: project.repositories[0].id, reason: 'Selected.' }]);
  store.applyInitialThreadScope(job.id, [project.repositories[0].id]);
  store.proposeScope(job.id, [project.repositories[1].id], [{ repositoryId: project.repositories[1].id, reason: 'Needed.' }]);
  const clicks = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: 'POST', url: `/jobs/${job.id}/scope-decision`, headers: auth, payload: { decision: 'reject' } })));
  assert.ok(clicks.every((response) => response.statusCode === 200));
  assert.equal(store.events(job.id).filter((event) => event.type === 'scope_decision').length, 1);
  store.setStatus(job.id, 'queued');
  const worker = new JobWorker(store, new JobEventBus(), { mock: { async run(_job, _repositories, emit) {
    emit('scope_required', 'Still need it', { suggestedRepositoryIds: [project.repositories[1].id], reasons: [] });
  } } }, { error() {} } as any, 5);
  worker.start();
  for (let attempt = 0; attempt < 100 && store.getJob(job.id)?.status !== 'done'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.getJob(job.id)?.status, 'done');
  assert.equal(store.getJob(job.id)?.proposedRepositoryIds, undefined);
  await worker.stop();
});

test('permissions are project/thread isolated and manual scope revokes prior grants', async () => {
  const { app, store, project, other } = await fixture();
  const first = store.createJob(project.id, 'First', project.repositories.map((repository) => repository.id), 'mock', 'manual');
  store.resolveScope(first.id, project.repositories.map((repository) => repository.id), []);
  store.applyInitialThreadScope(first.id, project.repositories.map((repository) => repository.id), true);
  store.setStatus(first.id, 'done');
  const narrowed = (await app.inject({ method: 'POST', url: `/jobs/${first.id}/continue`, headers: auth, payload: { message: 'front only', requestId: crypto.randomUUID(), scopeMode: 'manual', requestedRepositoryIds: [project.repositories[0].id] } })).json();
  assert.deepEqual(narrowed.resolvedRepositoryIds, [project.repositories[0].id]);
  assert.equal(narrowed.threadRepositoryPermissions.find((permission: { repositoryId: string }) => permission.repositoryId === project.repositories[1].id)?.decision, 'rejected');
  const separate = store.createJob(project.id, 'Separate', [], 'mock', 'auto');
  assert.deepEqual(store.threadPermissionIds(separate.id, 'approved'), []);
  const crossProject = store.createJob(other.id, 'Other', [], 'mock', 'auto');
  assert.deepEqual(store.threadPermissionIds(crossProject.id, 'approved'), []);
});
