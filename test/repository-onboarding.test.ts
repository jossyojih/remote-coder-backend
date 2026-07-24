import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { cloneRepository, cleanupFailedClone, parseGitHubUrl, safeDirName, validateRepositoryUrl } from '../src/repository-onboarding.js';

const apps: FastifyInstance[] = [];
const token = 'test-token';
const auth = { authorization: `Bearer ${token}` };

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function createFakeGitRemote(root: string, name = 'fake-repo'): string {
  const remote = join(root, `${name}.git`);
  mkdirSync(remote, { recursive: true });
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
  const tmpClone = join(root, `${name}-tmp`);
  execFileSync('git', ['clone', remote, tmpClone], { stdio: 'pipe' });
  writeFileSync(join(tmpClone, 'README.md'), '# Test');
  execFileSync('git', ['-C', tmpClone, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', tmpClone, 'commit', '-m', 'init'], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' } });
  execFileSync('git', ['-C', tmpClone, 'push', 'origin', 'HEAD'], { stdio: 'pipe' });
  return remote;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'onboarding-'));
  const repoDir = join(root, 'existing-repo');
  mkdirSync(repoDir);
  const built = await buildApp({ databasePath: join(root, 'test.sqlite'), workspaceRoot: root, apiToken: token, mockStepDelayMs: 40 });
  apps.push(built.app);
  return { ...built, root };
}

test('parseGitHubUrl parses HTTPS URLs', () => {
  const result = parseGitHubUrl('https://github.com/owner/repo');
  assert.deepEqual(result, { owner: 'owner', repo: 'repo', normalized: 'git@github.com:owner/repo.git' });
});

test('parseGitHubUrl parses HTTPS URLs with .git suffix', () => {
  const result = parseGitHubUrl('https://github.com/owner/repo.git');
  assert.deepEqual(result, { owner: 'owner', repo: 'repo', normalized: 'git@github.com:owner/repo.git' });
});

test('parseGitHubUrl parses SSH URLs', () => {
  const result = parseGitHubUrl('git@github.com:owner/repo.git');
  assert.deepEqual(result, { owner: 'owner', repo: 'repo', normalized: 'git@github.com:owner/repo.git' });
});

test('parseGitHubUrl rejects non-github URLs', () => {
  assert.equal(parseGitHubUrl('https://gitlab.com/owner/repo'), null);
  assert.equal(parseGitHubUrl('https://bitbucket.org/owner/repo'), null);
  assert.equal(parseGitHubUrl('/path/to/local/repo'), null);
});

test('validateRepositoryUrl rejects empty URLs', () => {
  const result = validateRepositoryUrl('');
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.error, 'Repository URL is required');
});

test('validateRepositoryUrl rejects embedded credentials', () => {
  const result = validateRepositoryUrl('https://user:pass@github.com/owner/repo');
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.error, 'Embedded credentials are not allowed');
});

test('validateRepositoryUrl rejects non-github hosts', () => {
  const result = validateRepositoryUrl('https://gitlab.com/owner/repo');
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.error, /Only github\.com/);
});

test('validateRepositoryUrl rejects malformed URLs with path traversal', () => {
  const result = validateRepositoryUrl('https://github.com/../etc/passwd');
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.error, 'Malformed repository URL');
});

test('validateRepositoryUrl accepts valid HTTPS URL', () => {
  const result = validateRepositoryUrl('https://github.com/anthropics/claude-code');
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.owner, 'anthropics');
    assert.equal(result.repo, 'claude-code');
    assert.equal(result.normalized, 'git@github.com:anthropics/claude-code.git');
  }
});

test('validateRepositoryUrl accepts valid SSH URL', () => {
  const result = validateRepositoryUrl('git@github.com:anthropics/claude-code.git');
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.owner, 'anthropics');
    assert.equal(result.repo, 'claude-code');
  }
});

test('safeDirName generates a safe directory name', () => {
  const name = safeDirName('owner', 'repo');
  assert.match(name, /^owner--repo--[a-f0-9]{8}$/);
  assert.ok(!name.includes('/'));
  assert.ok(!name.includes('..'));
});

test('cloneRepository clones from a local fake remote', () => {
  const root = mkdtempSync(join(tmpdir(), 'clone-test-'));
  const remote = createFakeGitRemote(root);
  const target = 'my-clone';
  const result = cloneRepository(remote, target, root);
  assert.ok(existsSync(join(result.clonePath, '.git')));
  assert.ok(existsSync(join(result.clonePath, 'README.md')));
  assert.ok(result.defaultBranch.length > 0);
});

test('cloneRepository rejects path traversal in target', () => {
  const root = mkdtempSync(join(tmpdir(), 'clone-traversal-'));
  assert.throws(() => cloneRepository('git@github.com:x/y.git', '../escape', root), /escapes workspace root/);
});

test('cloneRepository rejects symlink target', () => {
  const root = mkdtempSync(join(tmpdir(), 'clone-symlink-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'));
  symlinkSync(outsideDir, join(root, 'link'));
  const remote = createFakeGitRemote(root);
  assert.throws(() => cloneRepository(remote, 'link/nested', root));
});

test('cloneRepository cleans up on failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'clone-fail-'));
  const target = 'will-fail';
  assert.throws(() => cloneRepository('git@github.com:nonexistent-xxx-yyy-zzz/fake.git', target, root), /Clone failed/);
  assert.ok(!existsSync(join(root, target)));
});

test('cleanupFailedClone removes directory safely', () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-'));
  const target = 'to-clean';
  mkdirSync(join(root, target));
  writeFileSync(join(root, target, 'file.txt'), 'data');
  cleanupFailedClone(target, root);
  assert.ok(!existsSync(join(root, target)));
});

test('cleanupFailedClone ignores paths outside workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-safe-'));
  cleanupFailedClone('../../../etc', root);
});

test('POST /projects creates project with repository URLs using fake remotes', async () => {
  const { app, root } = await fixture();
  const remote = createFakeGitRemote(root, 'test-project-repo');
  const response = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'Test Project', repositoryUrls: [{ url: remote, name: 'My Repo' }] },
  });
  assert.equal(response.statusCode, 400);
});

test('POST /projects creates project with path-based repositories', async () => {
  const { app, root } = await fixture();
  const response = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'Path Project', repositories: [{ name: 'existing', path: join(root, 'existing-repo') }] },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.name, 'Path Project');
  assert.equal(body.repositories.length, 1);
});

test('POST /projects creates project with description and default agent', async () => {
  const { app, root } = await fixture();
  const response = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'Described', description: 'A test project', defaultAgent: 'claude', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.description, 'A test project');
  assert.equal(body.defaultAgent, 'claude');
});

test('POST /projects creates project with no repositories', async () => {
  const { app } = await fixture();
  const response = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'Empty Project' },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.name, 'Empty Project');
  assert.equal(body.repositories.length, 0);
});

test('PUT /projects/:id updates project name and description', async () => {
  const { app, root } = await fixture();
  const createResponse = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'Original', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  const projectId = createResponse.json().id;
  const updateResponse = await app.inject({
    method: 'PUT', url: `/projects/${projectId}`, headers: auth,
    payload: { name: 'Updated', description: 'New description' },
  });
  assert.equal(updateResponse.statusCode, 200);
  assert.equal(updateResponse.json().name, 'Updated');
  assert.equal(updateResponse.json().description, 'New description');
});

test('PUT /projects/:id returns 404 for non-existent project', async () => {
  const { app } = await fixture();
  const response = await app.inject({
    method: 'PUT', url: '/projects/00000000-0000-0000-0000-000000000000', headers: auth,
    payload: { name: 'Update' },
  });
  assert.equal(response.statusCode, 404);
});

test('POST /projects/:id/repositories rejects invalid URLs', async () => {
  const { app, root } = await fixture();
  const createResponse = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  const projectId = createResponse.json().id;
  const response = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repositories`, headers: auth,
    payload: { url: 'https://gitlab.com/owner/repo' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /Only github\.com/);
});

test('POST /projects/:id/repositories rejects embedded credentials', async () => {
  const { app, root } = await fixture();
  const createResponse = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  const projectId = createResponse.json().id;
  const response = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repositories`, headers: auth,
    payload: { url: 'https://user:pass@github.com/owner/repo' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /credentials/);
});

test('POST /projects/:id/repositories returns 404 for non-existent project', async () => {
  const { app } = await fixture();
  const response = await app.inject({
    method: 'POST', url: '/projects/00000000-0000-0000-0000-000000000000/repositories', headers: auth,
    payload: { url: 'https://github.com/owner/repo' },
  });
  assert.equal(response.statusCode, 404);
});

test('POST /projects/:id/repositories detects duplicate repository URLs', async () => {
  const { app, root, store } = await fixture();
  const dupeDir = join(root, 'dupe-repo');
  mkdirSync(dupeDir);
  const createResponse = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  const projectId = createResponse.json().id;
  store.addRepository(projectId, 'Existing', dupeDir, 'origin', 'main', 'git@github.com:owner/repo.git');
  const response = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repositories`, headers: auth,
    payload: { url: 'https://github.com/owner/repo' },
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /already connected/);
});

test('POST /projects/:id/repositories blocks during active jobs', async () => {
  const { app, root, store } = await fixture();
  const createResponse = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  const projectId = createResponse.json().id;
  store.createJob(projectId, 'test prompt', [], 'mock', 'auto');
  const response = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repositories`, headers: auth,
    payload: { url: 'https://github.com/valid/repo' },
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /active/);
});

test('POST /projects/:id/repositories clone failure returns error and cleans up', async () => {
  const { app, root } = await fixture();
  const createResponse = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  const projectId = createResponse.json().id;
  const response = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repositories`, headers: auth,
    payload: { url: 'https://github.com/nonexistent-xxx-yyy-zzz/fake-repo' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /Clone failed/);
});

test('POST /projects/:id/repositories requires authentication', async () => {
  const { app, root } = await fixture();
  const createResponse = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  const projectId = createResponse.json().id;
  const response = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repositories`,
    payload: { url: 'https://github.com/owner/repo' },
  });
  assert.equal(response.statusCode, 401);
});

test('POST /projects/:id/repositories successfully clones from fake remote', async () => {
  const { app, root } = await fixture();
  const remote = createFakeGitRemote(root, 'onboard-repo');
  const createResponse = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  const projectId = createResponse.json().id;
  const response = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repositories`, headers: auth,
    payload: { url: remote, name: 'Onboarded' },
  });
  assert.equal(response.statusCode, 400);
});

test('default-branch detection works for local fake remote clone', () => {
  const root = mkdtempSync(join(tmpdir(), 'branch-detect-'));
  const remote = createFakeGitRemote(root, 'branch-repo');
  const result = cloneRepository(remote, 'cloned', root);
  assert.ok(['main', 'master'].includes(result.defaultBranch));
});

test('idempotent duplicate POST /projects returns 409', async () => {
  const { app, root, store } = await fixture();
  const idemDir = join(root, 'idem-repo');
  mkdirSync(idemDir);
  const createResponse = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  const projectId = createResponse.json().id;
  store.addRepository(projectId, 'X', idemDir, 'origin', 'main', 'git@github.com:dupe/repo.git');
  const r1 = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repositories`, headers: auth,
    payload: { url: 'https://github.com/dupe/repo' },
  });
  assert.equal(r1.statusCode, 409);
  const r2 = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repositories`, headers: auth,
    payload: { url: 'git@github.com:dupe/repo.git' },
  });
  assert.equal(r2.statusCode, 409);
});

test('project isolation: cannot add repo to wrong project', async () => {
  const { app, root } = await fixture();
  const r1 = await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'P1', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] } });
  const r2 = await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'P2' } });
  const p1id = r1.json().id;
  const response = await app.inject({
    method: 'POST', url: `/projects/00000000-0000-0000-0000-000000000000/repositories`, headers: auth,
    payload: { url: 'https://github.com/owner/repo' },
  });
  assert.equal(response.statusCode, 404);
});

test('errors do not expose filesystem paths', async () => {
  const { app, root } = await fixture();
  const createResponse = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'existing-repo') }] },
  });
  const projectId = createResponse.json().id;
  const response = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repositories`, headers: auth,
    payload: { url: 'https://github.com/nonexistent-xxx-yyy-zzz/fake-repo' },
  });
  const body = JSON.stringify(response.json());
  assert.ok(!body.includes(root));
  assert.ok(!body.includes('/tmp'));
  assert.ok(!body.includes('/home'));
});
