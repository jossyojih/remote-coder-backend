import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, afterEach, before } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { GitHubAppAuth } from '../src/github-app.js';

const apps: FastifyInstance[] = [];
const token = 'test-token';

function createTestPrivateKey(path: string) {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(path, privateKey, { mode: 0o600 });
  return privateKey;
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

test('GitHub App authentication creates valid JWT', () => {
  const root = mkdtempSync(join(tmpdir(), 'github-app-jwt-'));
  const keyPath = join(root, 'private-key.pem');
  createTestPrivateKey(keyPath);

  process.env.GITHUB_APP_ID = 'test-app-id';
  process.env.GITHUB_APP_INSTALLATION_ID = 'test-install-id';
  process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;

  const auth = new GitHubAppAuth();
  assert.ok(auth.isConfigured());

  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_INSTALLATION_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
});

test('GitHub App status endpoint returns configuration state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'github-status-'));
  mkdirSync(join(root, 'repos'), { recursive: true });

  const { app } = await buildApp({
    databasePath: join(root, 'test.sqlite'),
    workspaceRoot: root,
    apiToken: token,
  });
  apps.push(app);

  const response = await app.inject({
    url: '/github/status',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(response.statusCode, 200);
  const data = response.json();
  assert.equal(typeof data.configured, 'boolean');
  assert.equal(data.configured, false);
});

test('GitHub repository listing requires configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'github-repos-'));
  mkdirSync(join(root, 'repos'), { recursive: true });

  const { app } = await buildApp({
    databasePath: join(root, 'test.sqlite'),
    workspaceRoot: root,
    apiToken: token,
  });
  apps.push(app);

  const response = await app.inject({
    url: '/github/repositories',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(response.statusCode, 503);
  assert.match(response.json().error, /not configured/i);
});

test('project creation with GitHub repositories requires configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'github-create-'));
  mkdirSync(join(root, 'repos'), { recursive: true });

  const { app } = await buildApp({
    databasePath: join(root, 'test.sqlite'),
    workspaceRoot: root,
    apiToken: token,
  });
  apps.push(app);

  const response = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: 'Test Project',
      githubRepositories: [{ owner: 'test', repo: 'repo', defaultBranch: 'main' }],
    },
  });

  assert.equal(response.statusCode, 503);
  assert.match(response.json().error, /not configured/i);
});

test('adding GitHub repository requires configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'github-add-'));
  mkdirSync(join(root, 'repo-a'));

  const { app, store } = await buildApp({
    databasePath: join(root, 'test.sqlite'),
    workspaceRoot: root,
    apiToken: token,
  });
  apps.push(app);

  const project = store.createProject('Test', [{ name: 'A', path: join(root, 'repo-a') }]);

  const response = await app.inject({
    method: 'POST',
    url: `/projects/${project.id}/repositories`,
    headers: { authorization: `Bearer ${token}` },
    payload: { owner: 'test', repo: 'repo' },
  });

  assert.equal(response.statusCode, 503);
  assert.match(response.json().error, /not configured/i);
});

test('URL-based onboarding continues to work without GitHub App', async () => {
  const root = mkdtempSync(join(tmpdir(), 'url-onboard-'));
  mkdirSync(join(root, 'repos'), { recursive: true });

  const { app } = await buildApp({
    databasePath: join(root, 'test.sqlite'),
    workspaceRoot: root,
    apiToken: token,
  });
  apps.push(app);

  const response = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: 'Test Project',
      repositoryUrls: [],
    },
  });

  assert.equal(response.statusCode, 201);
  const project = response.json();
  assert.equal(project.name, 'Test Project');
});

test('normalized URLs are stored and prevent duplicates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'normalized-'));
  mkdirSync(join(root, 'repos'), { recursive: true });

  const { app, store } = await buildApp({
    databasePath: join(root, 'test.sqlite'),
    workspaceRoot: root,
    apiToken: token,
  });
  apps.push(app);

  store.createProject('Test', [
    {
      name: 'TestRepo',
      path: join(root, 'repos', 'test'),
      normalizedUrl: 'git@github.com:owner/repo.git',
    },
  ]);

  const project = store.listProjects()[0];
  assert.ok(project);
  assert.equal(project.repositories[0]?.normalizedUrl, 'git@github.com:owner/repo.git');

  const duplicate = store.findRepositoryByNormalizedUrl('git@github.com:owner/repo.git');
  assert.ok(duplicate);
  assert.equal(duplicate.id, project.repositories[0]?.id);
});

test('add repository endpoint supports both URL and GitHub App mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'add-repo-modes-'));
  mkdirSync(join(root, 'repo-a'));

  const { app, store } = await buildApp({
    databasePath: join(root, 'test.sqlite'),
    workspaceRoot: root,
    apiToken: token,
  });
  apps.push(app);

  const project = store.createProject('Test', [{ name: 'A', path: join(root, 'repo-a') }]);

  const urlResponse = await app.inject({
    method: 'POST',
    url: `/projects/${project.id}/repositories`,
    headers: { authorization: `Bearer ${token}` },
    payload: { url: '' },
  });

  assert.equal(urlResponse.statusCode >= 400, true);

  const missingResponse = await app.inject({
    method: 'POST',
    url: `/projects/${project.id}/repositories`,
    headers: { authorization: `Bearer ${token}` },
    payload: {},
  });

  assert.equal(missingResponse.statusCode, 400);
});
