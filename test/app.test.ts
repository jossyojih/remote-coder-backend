import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

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
