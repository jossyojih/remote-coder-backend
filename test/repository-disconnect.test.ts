import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const apps: FastifyInstance[] = [];
const token = 'test-token';
const auth = { authorization: `Bearer ${token}` };

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

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'disconnect-'));
  const built = await buildApp({ databasePath: join(root, 'test.sqlite'), workspaceRoot: root, apiToken: token, mockStepDelayMs: 40 });
  apps.push(built.app);
  return { ...built, root };
}

test('DELETE /projects/:id/repositories/:repositoryId disconnects a managed repository and removes clone', async () => {
  const { app, root, store } = await fixture();
  const repoDir = createGitRepo(root, 'managed-repo');
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P' },
  });
  const projectId = createResp.json().id;
  const repo = store.addRepository(projectId, 'owner/repo', repoDir, 'origin', 'main', 'https://github.com/owner/repo');

  const response = await app.inject({
    method: 'DELETE', url: `/projects/${projectId}/repositories/${repo.id}`, headers: auth,
    payload: { confirmName: 'owner/repo' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.disconnected, true);
  assert.equal(body.cloneRemoved, true);
  assert.ok(!existsSync(repoDir));
});

test('DELETE disconnects legacy repository without deleting filesystem directory', async () => {
  const { app, root, store } = await fixture();
  const legacyDir = join(root, 'legacy-repo');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'file.txt'), 'content');
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P' },
  });
  const projectId = createResp.json().id;
  const repo = store.addRepository(projectId, 'Legacy Repo', legacyDir, 'origin', 'main', '');

  const response = await app.inject({
    method: 'DELETE', url: `/projects/${projectId}/repositories/${repo.id}`, headers: auth,
    payload: { confirmName: 'Legacy Repo' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.disconnected, true);
  assert.equal(body.cloneRemoved, false);
  assert.ok(existsSync(legacyDir));
});

test('DELETE blocks when repository has active jobs', async () => {
  const { app, root, store } = await fixture();
  const repoDir = createGitRepo(root, 'active-job-repo');
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P' },
  });
  const projectId = createResp.json().id;
  const repo = store.addRepository(projectId, 'owner/repo', repoDir, 'origin', 'main', 'https://github.com/owner/repo');
  store.createJob(projectId, 'test', [repo.id], 'mock', 'manual');

  const response = await app.inject({
    method: 'DELETE', url: `/projects/${projectId}/repositories/${repo.id}`, headers: auth,
    payload: { confirmName: 'owner/repo' },
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /active jobs/);
  assert.ok(existsSync(repoDir));
});

test('DELETE blocks when repository has pending promotions', async () => {
  const { app, root, store } = await fixture();
  const repoDir = createGitRepo(root, 'promo-repo');
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P' },
  });
  const projectId = createResp.json().id;
  const repo = store.addRepository(projectId, 'owner/repo', repoDir, 'origin', 'main', 'https://github.com/owner/repo');
  const job = store.createJob(projectId, 'test', [repo.id], 'mock', 'manual');
  store.resolveScope(job.id, [repo.id], []);
  store.setStatus(job.id, 'done');
  store.beginPromotion(job.id, 'test commit', [{
    jobId: job.id, repositoryId: repo.id, worktreePath: repoDir,
    sourcePath: repoDir, branch: 'main', remoteName: 'origin',
    remoteUrl: 'https://github.com/owner/repo', targetBranch: 'main',
    baseCommitSha: 'abc123', gitCommonDir: repoDir,
  }]);

  const response = await app.inject({
    method: 'DELETE', url: `/projects/${projectId}/repositories/${repo.id}`, headers: auth,
    payload: { confirmName: 'owner/repo' },
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /pending promotions/);
});

test('DELETE blocks when repository has active deployments', async () => {
  const { app, root, store } = await fixture();
  const repoDir = createGitRepo(root, 'deploy-repo');
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P' },
  });
  const projectId = createResp.json().id;
  const repo = store.addRepository(projectId, 'owner/repo', repoDir, 'origin', 'main', 'https://github.com/owner/repo');
  const job = store.createJob(projectId, 'test', [repo.id], 'mock', 'manual');
  store.resolveScope(job.id, [repo.id], []);
  store.setStatus(job.id, 'done');
  const run = {
    jobId: job.id, repositoryId: repo.id, worktreePath: repoDir,
    sourcePath: repoDir, branch: 'main', remoteName: 'origin',
    remoteUrl: 'https://github.com/owner/repo', targetBranch: 'main',
    baseCommitSha: 'abc123', gitCommonDir: repoDir,
  };
  store.beginPromotion(job.id, 'commit', [run]);
  store.setPromotionRepository(job.id, repo.id, 'promoted', { commitSha: 'abc123' });
  store.createDeployment(job.id, repo.id, 'abc123', run);

  const response = await app.inject({
    method: 'DELETE', url: `/projects/${projectId}/repositories/${repo.id}`, headers: auth,
    payload: { confirmName: 'owner/repo' },
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /active deployments/);
});

test('DELETE requires correct confirmation name', async () => {
  const { app, root, store } = await fixture();
  const repoDir = createGitRepo(root, 'confirm-repo');
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P' },
  });
  const projectId = createResp.json().id;
  const repo = store.addRepository(projectId, 'owner/repo', repoDir, 'origin', 'main', 'https://github.com/owner/repo');

  const response = await app.inject({
    method: 'DELETE', url: `/projects/${projectId}/repositories/${repo.id}`, headers: auth,
    payload: { confirmName: 'wrong/name' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /does not match/);
});

test('DELETE preserves historical threads and runs', async () => {
  const { app, root, store } = await fixture();
  const repoDir = createGitRepo(root, 'history-repo');
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P' },
  });
  const projectId = createResp.json().id;
  const repo = store.addRepository(projectId, 'owner/repo', repoDir, 'origin', 'main', 'https://github.com/owner/repo');
  const job = store.createJob(projectId, 'historical test', [repo.id], 'mock', 'manual');
  store.resolveScope(job.id, [repo.id], []);
  store.setStatus(job.id, 'done');
  store.addEvent(job.id, 'final_response', 'Done!');

  const response = await app.inject({
    method: 'DELETE', url: `/projects/${projectId}/repositories/${repo.id}`, headers: auth,
    payload: { confirmName: 'owner/repo' },
  });
  assert.equal(response.statusCode, 200);

  const storedJob = store.getJob(job.id);
  assert.ok(storedJob);
  assert.equal(storedJob.projectId, projectId);
  const events = store.events(job.id);
  assert.ok(events.length > 0);
});

test('DELETE rejects path traversal via symlink pointing outside workspace', async () => {
  const { app, root, store } = await fixture();
  const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret');
  const linkPath = join(root, 'symlinked-repo');
  symlinkSync(outsideDir, linkPath);
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P' },
  });
  const projectId = createResp.json().id;
  const repo = store.addRepository(projectId, 'owner/repo', linkPath, 'origin', 'main', 'https://github.com/owner/repo');

  const response = await app.inject({
    method: 'DELETE', url: `/projects/${projectId}/repositories/${repo.id}`, headers: auth,
    payload: { confirmName: 'owner/repo' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /outside workspace|symlink/);
  assert.ok(existsSync(outsideDir));
  assert.ok(existsSync(join(outsideDir, 'secret.txt')));
});

test('DELETE rejects symlink within workspace that points to sibling directory', async () => {
  const { app, root, store } = await fixture();
  const targetDir = join(root, 'real-target');
  mkdirSync(targetDir, { recursive: true });
  execFileSync('git', ['init', targetDir], { stdio: 'pipe' });
  writeFileSync(join(targetDir, 'important.txt'), 'do not delete');
  const linkPath = join(root, 'link-to-target');
  symlinkSync(targetDir, linkPath);
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P' },
  });
  const projectId = createResp.json().id;
  const repo = store.addRepository(projectId, 'owner/repo', linkPath, 'origin', 'main', 'https://github.com/owner/repo');

  const response = await app.inject({
    method: 'DELETE', url: `/projects/${projectId}/repositories/${repo.id}`, headers: auth,
    payload: { confirmName: 'owner/repo' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /symlink/);
  assert.ok(existsSync(targetDir));
  assert.ok(existsSync(join(targetDir, 'important.txt')));
});

test('DELETE rejects when repo path is outside workspace root', async () => {
  const { app, root, store } = await fixture();
  const outsideDir = mkdtempSync(join(tmpdir(), 'outsidews-'));
  mkdirSync(outsideDir, { recursive: true });
  execFileSync('git', ['init', outsideDir], { stdio: 'pipe' });
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P' },
  });
  const projectId = createResp.json().id;
  const repo = store.addRepository(projectId, 'owner/repo', outsideDir, 'origin', 'main', 'https://github.com/owner/repo');

  const response = await app.inject({
    method: 'DELETE', url: `/projects/${projectId}/repositories/${repo.id}`, headers: auth,
    payload: { confirmName: 'owner/repo' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /outside workspace/);
  assert.ok(existsSync(outsideDir));
});

test('DELETE blocks when managed clone has active worktrees', async () => {
  const { app, root, store } = await fixture();
  const repoDir = createGitRepo(root, 'worktree-repo');
  const worktreeDir = join(root, 'worktree-branch');
  execFileSync('git', ['-C', repoDir, 'worktree', 'add', worktreeDir, '-b', 'feature'], { stdio: 'pipe' });
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P' },
  });
  const projectId = createResp.json().id;
  const repo = store.addRepository(projectId, 'owner/repo', repoDir, 'origin', 'main', 'https://github.com/owner/repo');

  const response = await app.inject({
    method: 'DELETE', url: `/projects/${projectId}/repositories/${repo.id}`, headers: auth,
    payload: { confirmName: 'owner/repo' },
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /active worktrees/);
  assert.ok(existsSync(repoDir));
});

test('Re-adding a disconnected repository works idempotently', async () => {
  const { app, root, store } = await fixture();
  const repoDir = createGitRepo(root, 'readd-repo');
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P' },
  });
  const projectId = createResp.json().id;
  const repo = store.addRepository(projectId, 'owner/repo', repoDir, 'origin', 'main', 'https://github.com/owner/repo');

  const disconnectResp = await app.inject({
    method: 'DELETE', url: `/projects/${projectId}/repositories/${repo.id}`, headers: auth,
    payload: { confirmName: 'owner/repo' },
  });
  assert.equal(disconnectResp.statusCode, 200);

  const newRepoDir = createGitRepo(root, 'readd-repo-new');
  const reconnect = store.addRepository(projectId, 'owner/repo', newRepoDir, 'origin', 'main', 'https://github.com/owner/repo');
  assert.ok(reconnect.id);
  assert.notEqual(reconnect.id, repo.id);

  const project = store.getProject(projectId);
  assert.ok(project);
  assert.equal(project.repositories.length, 1);
  assert.equal(project.repositories[0].id, reconnect.id);
});

test('DELETE returns 404 for non-existent project', async () => {
  const { app } = await fixture();
  const response = await app.inject({
    method: 'DELETE', url: '/projects/00000000-0000-0000-0000-000000000000/repositories/00000000-0000-0000-0000-000000000001', headers: auth,
    payload: { confirmName: 'anything' },
  });
  assert.equal(response.statusCode, 404);
});

test('DELETE returns 404 for repository not in project', async () => {
  const { app, root, store } = await fixture();
  const repoDir = createGitRepo(root, 'wrong-project-repo');
  const p1 = await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'P1' } });
  const p2 = await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'P2' } });
  const repo = store.addRepository(p1.json().id, 'owner/repo', repoDir, 'origin', 'main', 'https://github.com/owner/repo');

  const response = await app.inject({
    method: 'DELETE', url: `/projects/${p2.json().id}/repositories/${repo.id}`, headers: auth,
    payload: { confirmName: 'owner/repo' },
  });
  assert.equal(response.statusCode, 404);
});

test('Repository removed from project listing after disconnect', async () => {
  const { app, root, store } = await fixture();
  const repoDir = createGitRepo(root, 'listing-repo');
  const createResp = await app.inject({
    method: 'POST', url: '/projects', headers: auth,
    payload: { name: 'P' },
  });
  const projectId = createResp.json().id;
  store.addRepository(projectId, 'owner/repo', repoDir, 'origin', 'main', 'https://github.com/owner/repo');

  let project = store.getProject(projectId);
  assert.equal(project!.repositories.length, 1);

  await app.inject({
    method: 'DELETE', url: `/projects/${projectId}/repositories/${project!.repositories[0].id}`, headers: auth,
    payload: { confirmName: 'owner/repo' },
  });

  project = store.getProject(projectId);
  assert.equal(project!.repositories.length, 0);
});
