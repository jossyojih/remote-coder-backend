import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const apps: FastifyInstance[] = [];
const token = 'test-token';
const renderOrigin = 'https://app.onrender.com';
const localhostOrigin = 'http://localhost:5173';

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function createGitRepo(root: string, name: string): string {
  const repoDir = join(root, name);
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', repoDir], { stdio: 'pipe' });
  writeFileSync(join(repoDir, 'README.md'), '# Test');
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init'], {
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' },
  });
  return repoDir;
}

async function fixture(origins: string[] = [renderOrigin, localhostOrigin]) {
  const root = mkdtempSync(join(tmpdir(), 'disconnect-cors-'));
  const built = await buildApp({ databasePath: join(root, 'test.sqlite'), workspaceRoot: root, apiToken: token, appOrigins: origins, mockStepDelayMs: 40 });
  apps.push(built.app);
  return { ...built, root };
}

async function setupProject(app: FastifyInstance, store: ReturnType<typeof buildApp extends (...a: any) => Promise<infer R> ? R : never>['store'], root: string) {
  const repoDir = createGitRepo(root, 'cors-repo');
  const createResp = await app.inject({ method: 'POST', url: '/projects', headers: { authorization: `Bearer ${token}` }, payload: { name: 'CorsProject' } });
  const projectId = createResp.json().id;
  const repo = store.addRepository(projectId, 'owner/cors-repo', repoDir, 'origin', 'main', 'https://github.com/owner/cors-repo');
  return { projectId, repo, repoDir };
}

test('OPTIONS preflight for repository-disconnect returns correct CORS headers from Render origin', async () => {
  const { app, store, root } = await fixture();
  const { projectId, repo } = await setupProject(app, store, root);
  const url = `/projects/${projectId}/repositories/${repo.id}`;

  const response = await app.inject({
    method: 'OPTIONS',
    url,
    headers: { origin: renderOrigin, 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'Authorization, Content-Type' },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['access-control-allow-origin'], renderOrigin);
  assert.match(response.headers['access-control-allow-methods'] as string, /DELETE/);
  assert.match(response.headers['access-control-allow-headers'] as string, /Authorization/);
  assert.match(response.headers['access-control-allow-headers'] as string, /Content-Type/);
  assert.equal(response.headers['access-control-max-age'], '600');
});

test('OPTIONS preflight for repository-disconnect returns correct CORS headers from localhost origin', async () => {
  const { app, store, root } = await fixture();
  const { projectId, repo } = await setupProject(app, store, root);
  const url = `/projects/${projectId}/repositories/${repo.id}`;

  const response = await app.inject({
    method: 'OPTIONS',
    url,
    headers: { origin: localhostOrigin, 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'Authorization, Content-Type' },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['access-control-allow-origin'], localhostOrigin);
  assert.match(response.headers['access-control-allow-methods'] as string, /DELETE/);
  assert.match(response.headers['access-control-allow-headers'] as string, /Authorization/);
  assert.match(response.headers['access-control-allow-headers'] as string, /Content-Type/);
});

test('OPTIONS preflight rejects denied origin', async () => {
  const { app, store, root } = await fixture();
  const { projectId, repo } = await setupProject(app, store, root);
  const url = `/projects/${projectId}/repositories/${repo.id}`;

  const response = await app.inject({
    method: 'OPTIONS',
    url,
    headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'Authorization' },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'Origin not allowed');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('authorized DELETE with valid origin returns success and CORS headers', async () => {
  const { app, store, root } = await fixture();
  const { projectId, repo } = await setupProject(app, store, root);
  const url = `/projects/${projectId}/repositories/${repo.id}`;

  const response = await app.inject({
    method: 'DELETE',
    url,
    headers: { origin: renderOrigin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { confirmName: 'owner/cors-repo' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['access-control-allow-origin'], renderOrigin);
  const body = response.json();
  assert.equal(body.disconnected, true);
});

test('unauthorized DELETE returns 401 with sanitized JSON error', async () => {
  const { app, store, root } = await fixture();
  const { projectId, repo } = await setupProject(app, store, root);
  const url = `/projects/${projectId}/repositories/${repo.id}`;

  const response = await app.inject({
    method: 'DELETE',
    url,
    headers: { origin: renderOrigin, authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
    payload: { confirmName: 'owner/cors-repo' },
  });

  assert.equal(response.statusCode, 401);
  const body = response.json();
  assert.equal(body.error, 'Unauthorized');
  assert.equal(body.stack, undefined);
  assert.equal(body.message, undefined);
});

test('DELETE from denied origin returns 403', async () => {
  const { app, store, root } = await fixture();
  const { projectId, repo } = await setupProject(app, store, root);
  const url = `/projects/${projectId}/repositories/${repo.id}`;

  const response = await app.inject({
    method: 'DELETE',
    url,
    headers: { origin: 'https://evil.example.com', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { confirmName: 'owner/cors-repo' },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'Origin not allowed');
});

test('DELETE blocked by active jobs returns sanitized 409 JSON', async () => {
  const { app, store, root } = await fixture();
  const { projectId, repo } = await setupProject(app, store, root);
  store.createJob(projectId, 'test', [repo.id], 'mock', 'manual');
  const url = `/projects/${projectId}/repositories/${repo.id}`;

  const response = await app.inject({
    method: 'DELETE',
    url,
    headers: { origin: renderOrigin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { confirmName: 'owner/cors-repo' },
  });

  assert.equal(response.statusCode, 409);
  const body = response.json();
  assert.match(body.error, /active jobs/);
  assert.equal(body.code, 'active_jobs');
  assert.equal(body.stack, undefined);
});
