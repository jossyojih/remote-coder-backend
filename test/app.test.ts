import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { Store } from '../src/database.js';

const apps: FastifyInstance[] = [];
const token = 'test-token';
async function fixture(delay = 40) {
  const root = mkdtempSync(join(tmpdir(), 'command-center-'));
  mkdirSync(join(root, 'repo-a')); mkdirSync(join(root, 'repo-b'));
  const built = await buildApp({ databasePath: join(root, 'test.sqlite'), workspaceRoot: root, apiToken: token, mockStepDelayMs: delay });
  apps.push(built.app); return { ...built, root };
}
const auth = { authorization: `Bearer ${token}` };
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function project(app: FastifyInstance, root: string, name = 'Project') {
  const response = await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name, repositories: [{ name: 'A', path: join(root, 'repo-a') }, { name: 'B', path: join(root, 'repo-b') }] } });
  assert.equal(response.statusCode, 201); return response.json();
}

test('health is public and other endpoints require bearer authentication', async () => {
  const { app } = await fixture();
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/projects' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/projects', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/projects', headers: auth })).statusCode, 200);
});

test('validates request bodies and rejects paths outside the workspace', async () => {
  const { app, root } = await fixture();
  assert.equal((await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: '', repositories: [] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'Bad', repositories: [{ name: 'x', path: tmpdir() }] } })).statusCode, 400);
  assert.ok(root);
});

test('creates a job with multiple repositories and enforces project ownership', async () => {
  const { app, root } = await fixture(100);
  const first = await project(app, root); const second = await project(app, root, 'Second');
  const payload = { projectId: first.id, prompt: 'Update both', selectedRepositoryIds: first.repositories.map((r: { id: string }) => r.id) };
  const response = await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload });
  assert.equal(response.statusCode, 201); assert.deepEqual(response.json().selectedRepositoryIds, payload.selectedRepositoryIds);
  const invalid = await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { ...payload, selectedRepositoryIds: [second.repositories[0].id] } });
  assert.equal(invalid.statusCode, 400);
});

test('cancels queued or running jobs durably', async () => {
  const { app, root } = await fixture(200); const p = await project(app, root);
  const created = await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId: p.id, prompt: 'Long work', selectedRepositoryIds: [p.repositories[0].id] } });
  const id = created.json().id;
  const cancelled = await app.inject({ method: 'POST', url: `/jobs/${id}/cancel`, headers: auth });
  assert.equal(cancelled.statusCode, 200); assert.equal(cancelled.json().status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await app.inject({ url: `/jobs/${id}`, headers: auth })).json().status, 'cancelled');
});

test('streams replayed and live events over SSE', async () => {
  const { app, root } = await fixture(25); const p = await project(app, root);
  const created = await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId: p.id, prompt: 'Stream work', selectedRepositoryIds: [p.repositories[0].id, p.repositories[1].id] } });
  const response = await app.inject({ url: `/jobs/${created.json().id}/events`, headers: auth });
  assert.equal(response.statusCode, 200); assert.match(response.headers['content-type'] ?? '', /text\/event-stream/);
  assert.match(response.body, /event: status/); assert.match(response.body, /Inspecting selected repositories/); assert.match(response.body, /Job completed/);
});

test('job detail and list aggregate persisted terminal output', async () => {
  const { app, store, root } = await fixture(500); const p = await project(app, root);
  const created = (await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId: p.id, prompt: 'Aggregate me', selectedRepositoryIds: [p.repositories[0].id] } })).json();
  await app.inject({ method: 'POST', url: `/jobs/${created.id}/cancel`, headers: auth });
  store.addEvent(created.id, 'token_usage', 'partial', { input_tokens: 1 });
  store.addEvent(created.id, 'token_usage', 'completed', { input_tokens: 12, output_tokens: 4 });
  store.addEvent(created.id, 'repository_result', 'collected', { repositoryId: p.repositories[0].id, repositoryName: 'A', status: 'clean' });
  store.addEvent(created.id, 'final_response', 'Persisted final answer', { ignored: true });
  store.addEvent(created.id, 'error', 'Actionable collection failure', { error: 'git status failed' });
  store.addEvent(created.id, 'question', 'Choose a branch', { question: 'Which branch should I use?' });
  for (const body of [
    (await app.inject({ url: `/jobs/${created.id}`, headers: auth })).json(),
    (await app.inject({ url: '/jobs', headers: auth })).json().find((job: { id: string }) => job.id === created.id),
  ]) {
    assert.equal(body.finalResponse, 'Persisted final answer');
    assert.deepEqual(body.usage, { input_tokens: 12, output_tokens: 4 });
    assert.equal(body.repositoryResults[0].repositoryName, 'A');
    assert.equal(body.error, 'git status failed');
    assert.equal(body.question, 'Which branch should I use?');
  }
});

test('creates idempotent linked follow-ups with inherited scope and bounded context', async () => {
  const { app, store, root } = await fixture(500); const p = await project(app, root);
  const original = (await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId: p.id, prompt: 'Original request', selectedRepositoryIds: p.repositories.map((repo: { id: string }) => repo.id), agent: 'mock' } })).json();
  await app.inject({ method: 'POST', url: `/jobs/${original.id}/cancel`, headers: auth });
  const requestId = crypto.randomUUID();
  const first = await app.inject({ method: 'POST', url: `/jobs/${original.id}/follow-ups`, headers: auth, payload: { message: 'Please continue', requestId } });
  assert.equal(first.statusCode, 201); const followUp = first.json();
  assert.equal(followUp.parentJobId, original.id); assert.equal(followUp.threadId, original.id);
  assert.equal(followUp.projectId, original.projectId); assert.equal(followUp.agent, original.agent);
  assert.deepEqual(followUp.selectedRepositoryIds, original.selectedRepositoryIds);
  assert.equal(followUp.conversationContext, undefined);
  assert.match(store.getJob(followUp.id)?.conversationContext ?? '', /Original request/); assert.ok((store.getJob(followUp.id)?.conversationContext.length ?? Infinity) <= 24_000);
  const duplicate = await app.inject({ method: 'POST', url: `/jobs/${original.id}/follow-ups`, headers: auth, payload: { message: 'Please continue', requestId } });
  assert.equal(duplicate.statusCode, 201); assert.equal(duplicate.json().id, followUp.id);
  const second = await app.inject({ method: 'POST', url: `/jobs/${original.id}/follow-ups`, headers: auth, payload: { message: 'Duplicate active run', requestId: crypto.randomUUID() } });
  assert.equal(second.statusCode, 409); assert.match(second.json().error, /latest job/);
  const conversation = await app.inject({ url: `/jobs/${followUp.id}/conversation`, headers: auth });
  assert.deepEqual(conversation.json().map((job: { id: string }) => job.id), [original.id, followUp.id]);
});

test('continue keeps, auto-selects, or manually corrects scope in the same thread', async () => {
  const { app, root } = await fixture(500); const p = await project(app, root);
  const original = (await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId: p.id, prompt: 'Original', scopeMode: 'manual', requestedRepositoryIds: [p.repositories[0].id], agent: 'mock' } })).json();
  await app.inject({ method: 'POST', url: `/jobs/${original.id}/cancel`, headers: auth });
  const manual = await app.inject({ method: 'POST', url: `/jobs/${original.id}/continue`, headers: auth, payload: { message: 'Try the API repository', requestId: crypto.randomUUID(), scopeMode: 'manual', requestedRepositoryIds: [p.repositories[1].id] } });
  assert.equal(manual.statusCode, 201); assert.deepEqual(manual.json().resolvedRepositoryIds, [p.repositories[1].id]); assert.equal(manual.json().threadId, original.id);
  await app.inject({ method: 'POST', url: `/jobs/${manual.json().id}/cancel`, headers: auth });
  const kept = await app.inject({ method: 'POST', url: `/jobs/${manual.json().id}/continue`, headers: auth, payload: { message: 'Keep going', requestId: crypto.randomUUID() } });
  assert.equal(kept.statusCode, 201); assert.deepEqual(kept.json().resolvedRepositoryIds, [p.repositories[1].id]); assert.equal(kept.json().threadId, original.id);
  await app.inject({ method: 'POST', url: `/jobs/${kept.json().id}/cancel`, headers: auth });
  const auto = await app.inject({ method: 'POST', url: `/jobs/${kept.json().id}/continue`, headers: auth, payload: { message: 'Fix A', requestId: crypto.randomUUID(), scopeMode: 'auto' } });
  assert.equal(auto.statusCode, 201); assert.deepEqual(auto.json().resolvedRepositoryIds, []); assert.equal(auto.json().threadId, original.id);
});

test('continue rejects duplicate and cross-project manual scope', async () => {
  const { app, root } = await fixture(500); const p = await project(app, root); const other = await project(app, root, 'Other');
  const original = (await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId: p.id, prompt: 'Original', selectedRepositoryIds: [p.repositories[0].id] } })).json();
  await app.inject({ method: 'POST', url: `/jobs/${original.id}/cancel`, headers: auth });
  const response = await app.inject({ method: 'POST', url: `/jobs/${original.id}/continue`, headers: auth, payload: { message: 'Wrong project', requestId: crypto.randomUUID(), scopeMode: 'manual', requestedRepositoryIds: [other.repositories[0].id] } });
  assert.equal(response.statusCode, 409); assert.match(response.json().error, /scope.*valid/i);
});

test('manual scope decision accepts only repositories in the job project', async () => {
  const { app, root } = await fixture(500); const p = await project(app, root); const other = await project(app, root, 'Other');
  const created = (await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId: p.id, prompt: 'Change repo-b', scopeMode: 'manual', requestedRepositoryIds: [p.repositories[0].id] } })).json();
  for (let attempt = 0; attempt < 100 && (await app.inject({ url: `/jobs/${created.id}`, headers: auth })).json().status !== 'needs_input'; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  const outside = await app.inject({ method: 'POST', url: `/jobs/${created.id}/scope-decision`, headers: auth, payload: { decision: 'choose', requestedRepositoryIds: [other.repositories[0].id] } });
  assert.equal(outside.statusCode, 409);
  const chosen = await app.inject({ method: 'POST', url: `/jobs/${created.id}/scope-decision`, headers: auth, payload: { decision: 'choose', requestedRepositoryIds: [p.repositories[1].id] } });
  assert.equal(chosen.statusCode, 200); assert.deepEqual(chosen.json().resolvedRepositoryIds, [p.repositories[1].id]);
});

test('rejects follow-up on an active job and preserves needs-input replies', async () => {
  const { app, store, root } = await fixture(500); const p = await project(app, root);
  const created = (await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId: p.id, prompt: 'Need info', selectedRepositoryIds: [p.repositories[0].id] } })).json();
  const activeFollowUp = await app.inject({ method: 'POST', url: `/jobs/${created.id}/follow-ups`, headers: auth, payload: { message: 'Too soon', requestId: crypto.randomUUID() } });
  assert.equal(activeFollowUp.statusCode, 409);
  await app.inject({ method: 'POST', url: `/jobs/${created.id}/cancel`, headers: auth });
  store.setStatus(created.id, 'needs_input'); store.addEvent(created.id, 'needs_input', 'What target?', { question: 'Which target?' });
  const detail = (await app.inject({ url: `/jobs/${created.id}`, headers: auth })).json(); assert.equal(detail.question, 'Which target?');
  const reply = await app.inject({ method: 'POST', url: `/jobs/${created.id}/reply`, headers: auth, payload: { message: 'Use A' } });
  assert.equal(reply.statusCode, 200); assert.ok(['queued', 'running'].includes(reply.json().status));
  assert.ok(store.events(created.id).some((event) => event.type === 'reply' && event.message === 'Use A'));
});

test('safely migrates existing jobs into root threads', () => {
  const root = mkdtempSync(join(tmpdir(), 'command-center-migration-')); const path = join(root, 'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE repositories (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id,path));
    CREATE TABLE jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), prompt TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'mock');
    CREATE TABLE job_repositories (job_id TEXT NOT NULL REFERENCES jobs(id), repository_id TEXT NOT NULL REFERENCES repositories(id), PRIMARY KEY(job_id,repository_id));
    CREATE TABLE job_events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), type TEXT NOT NULL, message TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    INSERT INTO projects VALUES ('project','Old','2024-01-01T00:00:00Z');
    INSERT INTO jobs VALUES ('job','project','Old prompt','done','2024-01-01T00:00:00Z','2024-01-01T00:00:00Z','mock');
  `);
  old.close(); const store = new Store(path);
  assert.equal(store.getJob('job')?.threadId, 'job');
  const columns = store.db.prepare('PRAGMA table_info(jobs)').all() as unknown as Array<{ name: string }>;
  assert.ok(['parent_job_id', 'thread_id', 'conversation_context', 'follow_up_request_id'].every((name) => columns.some((column) => column.name === name)));
  store.close();
});
