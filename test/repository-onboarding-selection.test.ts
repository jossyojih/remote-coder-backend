import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { addRepositorySchema } from '../src/schemas.js';

const apps: FastifyInstance[] = [];
const token = 'test-token';
const auth = { authorization: `Bearer ${token}` };

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'onboarding-selection-'));
  const repoDir = join(root, 'existing-repo');
  mkdirSync(repoDir);
  const built = await buildApp({ databasePath: join(root, 'test.sqlite'), workspaceRoot: root, apiToken: token, mockStepDelayMs: 40 });
  apps.push(built.app);
  return { ...built, root };
}

test('addRepositorySchema rejects both url and owner+repo when mode=url', () => {
  const result = addRepositorySchema.safeParse({ mode: 'url', url: 'https://github.com/a/b', owner: 'a', repo: 'b' });
  assert.equal(result.success, false);
});

test('addRepositorySchema rejects both url and owner+repo when mode=github', () => {
  const result = addRepositorySchema.safeParse({ mode: 'github', url: 'https://github.com/a/b', owner: 'a', repo: 'b' });
  assert.equal(result.success, false);
});

test('addRepositorySchema rejects url in github mode', () => {
  const result = addRepositorySchema.safeParse({ mode: 'github', url: 'https://github.com/a/b' });
  assert.equal(result.success, false);
});

test('addRepositorySchema rejects owner+repo in url mode', () => {
  const result = addRepositorySchema.safeParse({ mode: 'url', owner: 'a', repo: 'b' });
  assert.equal(result.success, false);
});

test('addRepositorySchema requires url in url mode', () => {
  const result = addRepositorySchema.safeParse({ mode: 'url' });
  assert.equal(result.success, false);
});

test('addRepositorySchema requires owner+repo in github mode', () => {
  const result = addRepositorySchema.safeParse({ mode: 'github' });
  assert.equal(result.success, false);
});

test('addRepositorySchema accepts valid url mode', () => {
  const result = addRepositorySchema.safeParse({ mode: 'url', url: 'https://github.com/owner/repo' });
  assert.equal(result.success, true);
});

test('addRepositorySchema accepts valid github mode', () => {
  const result = addRepositorySchema.safeParse({ mode: 'github', owner: 'octocat', repo: 'hello' });
  assert.equal(result.success, true);
});

test('addRepositorySchema accepts legacy (no mode) with url only', () => {
  const result = addRepositorySchema.safeParse({ url: 'https://github.com/owner/repo' });
  assert.equal(result.success, true);
});

test('addRepositorySchema accepts legacy (no mode) with owner+repo only', () => {
  const result = addRepositorySchema.safeParse({ owner: 'a', repo: 'b' });
  assert.equal(result.success, true);
});

test('addRepositorySchema rejects legacy (no mode) with neither url nor owner+repo', () => {
  const result = addRepositorySchema.safeParse({});
  assert.equal(result.success, false);
});

test('addRepositorySchema rejects legacy (no mode) with both url and owner+repo', () => {
  const result = addRepositorySchema.safeParse({ url: 'https://github.com/a/b', owner: 'a', repo: 'b' });
  assert.equal(result.success, false);
});

test('POST /projects/:id/repositories with mode=url validates correctly', async () => {
  const { app, root } = await fixture();
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  const projectId = createResp.json().id;

  const response = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repositories`, headers: auth,
    payload: { mode: 'url', url: 'https://gitlab.com/owner/repo' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /Only github\.com/);
});

test('POST /projects/:id/repositories rejects mode=url with owner+repo', async () => {
  const { app, root } = await fixture();
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  const projectId = createResp.json().id;

  const response = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repositories`, headers: auth,
    payload: { mode: 'url', owner: 'a', repo: 'b' },
  });
  assert.equal(response.statusCode, 400);
});

test('POST /projects/:id/repositories rejects mode=github with url', async () => {
  const { app, root } = await fixture();
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  const projectId = createResp.json().id;

  const response = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repositories`, headers: auth,
    payload: { mode: 'github', url: 'https://github.com/a/b' },
  });
  assert.equal(response.statusCode, 400);
});
