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
  const root = mkdtempSync(join(tmpdir(), 'command-center-search-'));
  mkdirSync(join(root, 'repo-a')); mkdirSync(join(root, 'repo-b'));
  const built = await buildApp({ databasePath: join(root, 'test.sqlite'), workspaceRoot: root, apiToken: token, mockStepDelayMs: delay });
  apps.push(built.app); return { ...built, root };
}
const auth = { authorization: `Bearer ${token}` };
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function createProject(app: FastifyInstance, root: string, name = 'Test Project') {
  const response = await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name, repositories: [{ name: 'A', path: join(root, 'repo-a') }, { name: 'B', path: join(root, 'repo-b') }] } });
  assert.equal(response.statusCode, 201);
  return response.json();
}

async function createJob(app: FastifyInstance, projectId: string, selectedRepositoryIds: string[], prompt = 'Test prompt') {
  const response = await app.inject({
    method: 'POST', url: '/jobs', headers: auth,
    payload: { projectId, prompt, selectedRepositoryIds, scopeMode: 'manual', requestedRepositoryIds: selectedRepositoryIds, agent: 'mock' },
  });
  assert.equal(response.statusCode, 201);
  return response.json();
}

test('search requires authentication', async () => {
  const { app } = await fixture();
  const response = await app.inject({ url: '/threads/search?query=test' });
  assert.equal(response.statusCode, 401);
});

test('search returns empty results for no match', async () => {
  const { app, root } = await fixture();
  await createProject(app, root);
  const response = await app.inject({ url: '/threads/search?query=nonexistent', headers: auth });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.results.length, 0);
  assert.equal(body.total, 0);
  assert.equal(body.page, 1);
  assert.equal(body.totalPages, 0);
});

test('search finds threads by prompt text', async () => {
  const { app, root } = await fixture();
  const project = await createProject(app, root);
  const repoIds = project.repositories.map((r: { id: string }) => r.id);
  await createJob(app, project.id, repoIds, 'Add authentication middleware');
  await createJob(app, project.id, repoIds, 'Fix database connection pooling');

  const response = await app.inject({ url: '/threads/search?query=authentication', headers: auth });
  const body = response.json();
  assert.equal(body.results.length, 1);
  assert.ok(body.results[0].title.includes('authentication'));
});

test('search pagination works correctly', async () => {
  const { app, root } = await fixture();
  const project = await createProject(app, root);
  const repoIds = project.repositories.map((r: { id: string }) => r.id);
  for (let i = 0; i < 5; i++) {
    await createJob(app, project.id, repoIds, `Task number ${i}`);
  }

  const page1 = await app.inject({ url: '/threads/search?query=Task&pageSize=2&page=1', headers: auth });
  const body1 = page1.json();
  assert.equal(body1.results.length, 2);
  assert.equal(body1.total, 5);
  assert.equal(body1.page, 1);
  assert.equal(body1.totalPages, 3);

  const page2 = await app.inject({ url: '/threads/search?query=Task&pageSize=2&page=2', headers: auth });
  const body2 = page2.json();
  assert.equal(body2.results.length, 2);
  assert.equal(body2.page, 2);

  const page3 = await app.inject({ url: '/threads/search?query=Task&pageSize=2&page=3', headers: auth });
  const body3 = page3.json();
  assert.equal(body3.results.length, 1);
});

test('search filters by project', async () => {
  const { app, root } = await fixture();
  const project1 = await createProject(app, root, 'Alpha');
  const project2 = await createProject(app, root, 'Beta');
  const repoIds1 = project1.repositories.map((r: { id: string }) => r.id);
  const repoIds2 = project2.repositories.map((r: { id: string }) => r.id);
  await createJob(app, project1.id, repoIds1, 'Shared keyword search task');
  await createJob(app, project2.id, repoIds2, 'Shared keyword search task');

  const response = await app.inject({ url: `/threads/search?query=search&projectId=${project1.id}`, headers: auth });
  const body = response.json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].projectId, project1.id);
});

test('search filters by status', async () => {
  const { app, root, store } = await fixture();
  const project = await createProject(app, root);
  const repoIds = project.repositories.map((r: { id: string }) => r.id);
  const job1 = await createJob(app, project.id, repoIds, 'Running task');
  const job2 = await createJob(app, project.id, repoIds, 'Done task');
  store.setStatus(job2.id, 'done');

  const response = await app.inject({ url: '/threads/search?status=done', headers: auth });
  const body = response.json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].latestStatus, 'done');
});

test('search filters by agent', async () => {
  const { app, root } = await fixture();
  const project = await createProject(app, root);
  const repoIds = project.repositories.map((r: { id: string }) => r.id);
  await createJob(app, project.id, repoIds, 'Mock agent task');

  const response = await app.inject({ url: '/threads/search?agent=mock', headers: auth });
  const body = response.json();
  assert.ok(body.results.length >= 1);
  assert.ok(body.results.every((r: { agent: string }) => r.agent === 'mock'));
});

test('search excludes archived threads by default', async () => {
  const { app, root, store } = await fixture();
  const project = await createProject(app, root);
  const repoIds = project.repositories.map((r: { id: string }) => r.id);
  const job1 = await createJob(app, project.id, repoIds, 'Active search thread');
  const job2 = await createJob(app, project.id, repoIds, 'Archived search thread');
  store.setStatus(job2.id, 'done');
  store.archiveThread(job2.id);

  const response = await app.inject({ url: '/threads/search?query=search+thread', headers: auth });
  const body = response.json();
  assert.equal(body.results.length, 1);
  assert.ok(body.results[0].title.includes('Active'));
});

test('search includes archived threads when filter set', async () => {
  const { app, root, store } = await fixture();
  const project = await createProject(app, root);
  const repoIds = project.repositories.map((r: { id: string }) => r.id);
  const job1 = await createJob(app, project.id, repoIds, 'Active visible thread');
  const job2 = await createJob(app, project.id, repoIds, 'Archived visible thread');
  store.setStatus(job2.id, 'done');
  store.archiveThread(job2.id);

  const response = await app.inject({ url: '/threads/search?query=visible+thread&includeArchived=true', headers: auth });
  const body = response.json();
  assert.equal(body.results.length, 2);
  const archived = body.results.find((r: { archived: boolean }) => r.archived);
  assert.ok(archived);
});

test('search groups by thread with follow-ups', async () => {
  const { app, root, store } = await fixture();
  const project = await createProject(app, root);
  const repoIds = project.repositories.map((r: { id: string }) => r.id);
  const parent = await createJob(app, project.id, repoIds, 'Grouped thread parent task');
  store.setStatus(parent.id, 'done');

  const followUpResponse = await app.inject({
    method: 'POST', url: `/jobs/${parent.id}/follow-ups`, headers: auth,
    payload: { message: 'Follow-up message for grouped thread', requestId: crypto.randomUUID(), scopeMode: 'manual', requestedRepositoryIds: repoIds },
  });
  assert.equal(followUpResponse.statusCode, 201);

  const response = await app.inject({ url: '/threads/search?query=Grouped+thread', headers: auth });
  const body = response.json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].runCount, 2);
});

test('search result contains expected fields', async () => {
  const { app, root } = await fixture();
  const project = await createProject(app, root);
  const repoIds = project.repositories.map((r: { id: string }) => r.id);
  await createJob(app, project.id, repoIds, 'Field check task');

  const response = await app.inject({ url: '/threads/search?query=Field+check', headers: auth });
  const body = response.json();
  assert.equal(body.results.length, 1);
  const result = body.results[0];
  assert.ok(result.threadId);
  assert.equal(result.projectId, project.id);
  assert.ok(result.title);
  assert.ok(result.latestStatus);
  assert.ok(result.agent);
  assert.equal(typeof result.runCount, 'number');
  assert.ok(Array.isArray(result.repositoryIds));
  assert.ok(result.updatedAt);
  assert.ok(result.createdAt);
  assert.equal(typeof result.archived, 'boolean');
});

test('search enforces project ownership via project filter', async () => {
  const { app, root } = await fixture();
  const project1 = await createProject(app, root, 'Project One');
  const project2 = await createProject(app, root, 'Project Two');
  const repoIds1 = project1.repositories.map((r: { id: string }) => r.id);
  await createJob(app, project1.id, repoIds1, 'Private task for project one');

  const response = await app.inject({ url: `/threads/search?query=Private&projectId=${project2.id}`, headers: auth });
  const body = response.json();
  assert.equal(body.results.length, 0);
});
