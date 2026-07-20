import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prepareRepositories, runCommand } from '../src/agent-runtime.js';

const apps: FastifyInstance[] = []; const token = 'promotion-test-token'; const auth = { authorization: `Bearer ${token}` };
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function gitRepository(root: string, name: string) {
  const remote = join(root, `${name}.git`); const source = join(root, name);
  await runCommand('git', ['init', '--bare', remote]); await runCommand('git', ['clone', remote, source]);
  await runCommand('git', ['config', 'user.name', 'Test Agent'], source); await runCommand('git', ['config', 'user.email', 'agent@example.test'], source);
  writeFileSync(join(source, 'README.md'), `${name}\n`); await runCommand('git', ['add', 'README.md'], source); await runCommand('git', ['commit', '-m', 'initial'], source);
  await runCommand('git', ['branch', '-M', 'main'], source); await runCommand('git', ['push', '-u', 'origin', 'main'], source);
  return { remote, source, initial: (await runCommand('git', ['rev-parse', 'HEAD'], source)).stdout.trim() };
}

async function setup(count = 1, deployIndex?: number) {
  const root = mkdtempSync(join(tmpdir(), 'promotion-')); const runsRoot = join(root, 'runs'); mkdirSync(runsRoot);
  const repositories = []; for (let i = 0; i < count; i++) repositories.push(await gitRepository(root, `repo-${i + 1}`));
  const starts: string[] = [];
  const built = await buildApp({ databasePath: join(root, 'db.sqlite'), workspaceRoot: root, runsRoot, apiToken: token, deploymentApiToken: 'deploy-token', backendDeployRepositoryPath: deployIndex === undefined ? undefined : repositories[deployIndex]!.source, deploymentStarter: async (id) => { starts.push(id); }, mockStepDelayMs: 10_000 }); apps.push(built.app);
  const project = (await built.app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'Project', repositories: repositories.map((r, i) => ({ name: `Repo ${i + 1}`, path: r.source })) } })).json();
  const created = (await built.app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId: project.id, prompt: 'fake agent changes', selectedRepositoryIds: project.repositories.map((r: { id: string }) => r.id), agent: 'mock' } })).json();
  await built.app.inject({ method: 'POST', url: `/jobs/${created.id}/cancel`, headers: auth });
  built.store.resolveScope(created.id, project.repositories.map((r: { id: string }) => r.id), []);
  const prepared = (await prepareRepositories(built.store.getJob(created.id)!, built.store.repositories(project.repositories.map((r: { id: string }) => r.id)), root, runsRoot, (_type, _message, data) => built.store.recordRepositoryRun({ jobId: created.id, ...(data as Omit<import('../src/types.js').JobRepositoryRun, 'jobId'>) }))).prepared;
  built.store.setStatus(created.id, 'done'); return { ...built, root, runsRoot, repositories, project, jobId: created.id, prepared, starts };
}

test('worktrees use the latest remote commit and review returns bounded file diffs', async () => {
  const f = await setup(); writeFileSync(join(f.prepared[0].worktreePath, 'change.txt'), 'hello\n');
  assert.equal(f.prepared[0].baseCommitSha, f.repositories[0].initial);
  const response = await f.app.inject({ url: `/jobs/${f.jobId}/changes`, headers: auth }); assert.equal(response.statusCode, 200);
  const body = response.json(); assert.equal(body.repositories[0].changedFiles[0].path, 'change.txt'); assert.equal(body.repositories[0].additions, 2); assert.ok(body.limits.perFileDiffBytes <= 32_000);
});

test('promotes safely, returns commit metadata, and is idempotent', async () => {
  const f = await setup(); appendFileSync(join(f.prepared[0].worktreePath, 'README.md'), 'approved\n');
  const payload = { commitMessage: 'Approved change', approvedRepositoryIds: [f.project.repositories[0].id] };
  const first = await f.app.inject({ method: 'POST', url: `/jobs/${f.jobId}/promotions`, headers: auth, payload }); assert.equal(first.statusCode, 200, first.body);
  const result = first.json(); assert.equal(result.status, 'promoted'); assert.match(result.repositories[0].commitSha, /^[a-f0-9]{40}$/); assert.equal(result.repositories[0].targetBranch, 'main');
  const second = await f.app.inject({ method: 'POST', url: `/jobs/${f.jobId}/promotions`, headers: auth, payload }); assert.equal(second.statusCode, 200); assert.equal(second.json().repositories[0].commitSha, result.repositories[0].commitSha);
});

test('promotion summaries persist modified, added, and deleted file statistics', async () => {
  const f = await setup(); const worktree = f.prepared[0].worktreePath;
  writeFileSync(join(worktree, 'deleted.txt'), 'remove me\n');
  await runCommand('git', ['add', 'deleted.txt'], worktree);
  await runCommand('git', ['commit', '--no-gpg-sign', '-m', 'test fixture'], worktree);
  await runCommand('git', ['push', 'origin', 'HEAD:main'], worktree);
  const fixtureCommit = (await runCommand('git', ['rev-parse', 'HEAD'], worktree)).stdout.trim();
  f.store.db.prepare('UPDATE job_repository_runs SET base_commit_sha=? WHERE job_id=? AND repository_id=?').run(fixtureCommit, f.jobId, f.project.repositories[0].id);
  writeFileSync(join(worktree, 'README.md'), 'updated\nsecond line\n');
  writeFileSync(join(worktree, 'added.txt'), 'first\nsecond\n');
  rmSync(join(worktree, 'deleted.txt'));

  const response = await f.app.inject({ method: 'POST', url: `/jobs/${f.jobId}/promotions`, headers: auth, payload: { commitMessage: 'Mixed file changes', approvedRepositoryIds: [f.project.repositories[0].id] } });
  assert.equal(response.statusCode, 200, response.body);
  const summary = response.json().repositories[0];
  assert.deepEqual({ additions: summary.additions, deletions: summary.deletions, changedFiles: summary.changedFiles }, { additions: 4, deletions: 2, changedFiles: 3 });
  const changes = (await f.app.inject({ url: `/jobs/${f.jobId}/changes`, headers: auth })).json();
  assert.deepEqual({ additions: changes.promotion.repositories[0].additions, deletions: changes.promotion.repositories[0].deletions, changedFiles: changes.promotion.repositories[0].changedFiles }, { additions: 4, deletions: 2, changedFiles: 3 });
});

test('queues one exact-commit backend deployment and exposes only sanitized authenticated status', async () => {
  const f = await setup(2, 0); for (const repo of f.prepared) appendFileSync(join(repo.worktreePath, 'README.md'), 'approved\n');
  const payload = { commitMessage: 'Approved change', approvedRepositoryIds: f.project.repositories.map((r: { id: string }) => r.id) };
  const promoted = await f.app.inject({ method: 'POST', url: `/jobs/${f.jobId}/promotions`, headers: auth, payload }); assert.equal(promoted.statusCode, 200, promoted.body);
  assert.equal(f.starts.length, 1);
  const backendCommit = promoted.json().repositories.find((r: { repositoryId: string }) => r.repositoryId === f.project.repositories[0].id).commitSha;
  const status = await f.app.inject({ url: `/jobs/${f.jobId}/deployments`, headers: auth }); assert.equal(status.statusCode, 200);
  assert.equal(status.json().length, 1); assert.equal(status.json()[0].commitSha, backendCommit); assert.equal(status.json()[0].status, 'queued');
  assert.equal('sourcePath' in status.json()[0], false); assert.equal((await f.app.inject({ url: `/jobs/${f.jobId}/deployments` })).statusCode, 401);
  const claim = await f.app.inject({ method: 'POST', url: `/internal/deployments/${f.starts[0]}/claim`, headers: { authorization: 'Bearer deploy-token' } });
  assert.equal(claim.statusCode, 200); assert.equal(claim.json().commitSha, backendCommit); assert.equal(claim.json().sourcePath, f.repositories[0].source);
  assert.equal((await f.app.inject({ method: 'POST', url: `/internal/deployments/${f.starts[0]}/claim`, headers: { authorization: 'Bearer deploy-token' } })).statusCode, 409);
  const done = await f.app.inject({ method: 'POST', url: `/internal/deployments/${f.starts[0]}/state`, headers: { authorization: 'Bearer deploy-token' }, payload: { status: 'succeeded', stage: 'healthy' } }); assert.equal(done.statusCode, 200);
  await f.app.inject({ method: 'POST', url: `/jobs/${f.jobId}/promotions`, headers: auth, payload }); assert.equal(f.starts.length, 1);
});

test('Fastify parser errors on claim and state remain client errors', async () => {
  const f = await setup();
  for (const path of [`/internal/deployments/${crypto.randomUUID()}/claim`, `/internal/deployments/${crypto.randomUUID()}/state`]) {
    const response = await f.app.inject({ method: 'POST', url: path, headers: { authorization: 'Bearer deploy-token', 'content-type': 'application/json' }, payload: '' });
    assert.equal(response.statusCode, 400, response.body);
  }
});

test('frontend-only promotion does not queue an EC2 deployment', async () => {
  const f = await setup(2, 0); appendFileSync(join(f.prepared[1].worktreePath, 'README.md'), 'frontend\n');
  const response = await f.app.inject({ method: 'POST', url: `/jobs/${f.jobId}/promotions`, headers: auth, payload: { commitMessage: 'Frontend only', approvedRepositoryIds: [f.project.repositories[1].id] } });
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(f.starts, []); assert.deepEqual(f.store.deploymentsForJob(f.jobId), []);
});

test('rejects stale remotes without pushing job changes', async () => {
  const f = await setup(); appendFileSync(join(f.prepared[0].worktreePath, 'README.md'), 'job\n');
  const other = join(f.root, 'other'); await runCommand('git', ['clone', '--branch', 'main', f.repositories[0].remote, other]); await runCommand('git', ['config', 'user.name', 'Other'], other); await runCommand('git', ['config', 'user.email', 'other@example.test'], other);
  writeFileSync(join(other, 'remote.txt'), 'advanced\n'); await runCommand('git', ['add', 'remote.txt'], other); await runCommand('git', ['commit', '-m', 'advance'], other); await runCommand('git', ['push', 'origin', 'main'], other);
  const response = await f.app.inject({ method: 'POST', url: `/jobs/${f.jobId}/promotions`, headers: auth, payload: { commitMessage: 'Should conflict', approvedRepositoryIds: [f.project.repositories[0].id] } });
  assert.equal(response.statusCode, 409); assert.equal(response.json().repositories[0].conflict, true); assert.match(response.json().repositories[0].error, /advanced/);
});

test('supports multi-repository partial failure and retries only failed repositories', async () => {
  const f = await setup(2); for (const repo of f.prepared) appendFileSync(join(repo.worktreePath, 'README.md'), 'job\n');
  const hook = join(f.repositories[1].remote, 'hooks', 'pre-receive'); writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
  const payload = { commitMessage: 'Both repos', approvedRepositoryIds: f.project.repositories.map((r: { id: string }) => r.id) };
  const first = await f.app.inject({ method: 'POST', url: `/jobs/${f.jobId}/promotions`, headers: auth, payload }); assert.equal(first.statusCode, 409); assert.deepEqual(first.json().repositories.map((r: { status: string }) => r.status), ['promoted', 'failed']);
  writeFileSync(hook, '#!/bin/sh\nexit 0\n'); const retry = await f.app.inject({ method: 'POST', url: `/jobs/${f.jobId}/promotions`, headers: auth, payload }); assert.equal(retry.statusCode, 200, retry.body); assert.ok(retry.json().repositories.every((r: { status: string }) => r.status === 'promoted'));
});

test('does not promote no-change jobs and rejects injection-shaped inputs', async () => {
  const f = await setup(); const review = (await f.app.inject({ url: `/jobs/${f.jobId}/changes`, headers: auth })).json(); assert.equal(review.hasChanges, false);
  assert.equal((await f.app.inject({ method: 'POST', url: `/jobs/${f.jobId}/promotions`, headers: auth, payload: { commitMessage: '--upload-pack=evil', approvedRepositoryIds: [f.project.repositories[0].id] } })).statusCode, 409);
  appendFileSync(join(f.prepared[0].worktreePath, 'README.md'), 'safe\n');
  const injected = await f.app.inject({ method: 'POST', url: `/jobs/${f.jobId}/promotions`, headers: auth, payload: { commitMessage: 'safe\0bad', approvedRepositoryIds: [f.project.repositories[0].id] } }); assert.equal(injected.statusCode, 400);
  const pathAttempt = await f.app.inject({ method: 'POST', url: `/jobs/${f.jobId}/promotions`, headers: auth, payload: { commitMessage: 'x', approvedRepositoryIds: ['../../repo'] } }); assert.equal(pathAttempt.statusCode, 400);
});

test('policy APIs default safely, support repository overrides, and backend blocks policy bypass', async () => {
  const f = await setup(2);
  assert.equal(f.project.promotionPolicy, 'review_required');
  assert.ok(f.project.repositories.every((repository: { effectivePromotionPolicy: string }) => repository.effectivePromotionPolicy === 'review_required'));
  const projectUpdate = await f.app.inject({ method: 'PUT', url: `/projects/${f.project.id}/promotion-policy`, headers: auth, payload: { promotionPolicy: 'auto_push' } });
  assert.equal(projectUpdate.statusCode, 200); assert.ok(projectUpdate.json().repositories.every((repository: { effectivePromotionPolicy: string }) => repository.effectivePromotionPolicy === 'auto_push'));
  const override = await f.app.inject({ method: 'PUT', url: `/projects/${f.project.id}/repositories/${f.project.repositories[1].id}/promotion-policy`, headers: auth, payload: { promotionPolicyOverride: 'read_only' } });
  assert.equal(override.statusCode, 200); assert.equal(override.json().repositories[1].effectivePromotionPolicy, 'read_only');
  appendFileSync(join(f.prepared[0].worktreePath, 'README.md'), 'change\n');
  const bypass = await f.app.inject({ method: 'POST', url: `/jobs/${f.jobId}/promotions`, headers: auth, payload: { commitMessage: 'Bypass', approvedRepositoryIds: [f.project.repositories[0].id] } });
  assert.equal(bypass.statusCode, 409); assert.equal(bypass.json().code, 'policy_forbidden');
  assert.equal((await f.app.inject({ method: 'PUT', url: `/projects/${f.project.id}/promotion-policy`, payload: { promotionPolicy: 'read_only' } })).statusCode, 401);
});

test('mixed effective policies auto-push only validated auto repositories and audit every repository', async () => {
  const f = await setup(3, 0);
  await f.app.inject({ method: 'PUT', url: `/projects/${f.project.id}/repositories/${f.project.repositories[0].id}/promotion-policy`, headers: auth, payload: { promotionPolicyOverride: 'auto_push' } });
  await f.app.inject({ method: 'PUT', url: `/projects/${f.project.id}/repositories/${f.project.repositories[2].id}/promotion-policy`, headers: auth, payload: { promotionPolicyOverride: 'read_only' } });
  for (const repo of f.prepared) appendFileSync(join(repo.worktreePath, 'README.md'), 'policy change\n');
  const service = new (await import('../src/promotion.js')).PromotionService(f.store, f.root, f.runsRoot, new (await import('../src/deployment.js')).DeploymentCoordinator(f.store, f.repositories[0].source, async (id) => { f.starts.push(id); }));
  await service.applyEffectivePolicies(f.jobId);
  const review = await service.review(f.jobId); const auto = f.store.getPromotion(f.jobId)!;
  assert.equal(auto.repositories.length, 1); assert.equal(auto.repositories[0].repositoryId, f.project.repositories[0].id); assert.equal(auto.repositories[0].status, 'promoted');
  assert.equal(review.repositories[1].hasChanges, true); assert.equal(review.repositories[2].hasChanges, false);
  const audits = f.store.events(f.jobId).filter((event) => event.type === 'promotion_policy').slice(-3); assert.deepEqual(new Set(audits.map((event) => (event.data as { repositoryId: string }).repositoryId)), new Set(f.project.repositories.map((repository: { id: string }) => repository.id)));
  assert.equal(f.starts.length, 1);
});
