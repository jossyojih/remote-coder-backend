import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type CommandCenterApp } from '../src/app.js';
import { runCommand, prepareRepositories } from '../src/agent-runtime.js';

describe('Continuation after maintenance cleanup', () => {
  let app: CommandCenterApp;
  let tmpDir: string;
  let apiToken: string;
  let workspaceRoot: string;
  let runsRoot: string;

  async function setupRepository(name: string) {
    const repoRemote = join(workspaceRoot, `${name}.git`);
    const repoPath = join(workspaceRoot, name);

    await runCommand('git', ['init', '--bare', repoRemote]);
    await runCommand('git', ['clone', repoRemote, repoPath]);
    await runCommand('git', ['-C', repoPath, 'config', 'user.email', 'test@test.com']);
    await runCommand('git', ['-C', repoPath, 'config', 'user.name', 'Test']);

    await writeFile(join(repoPath, 'README.md'), 'test\n');
    await runCommand('git', ['-C', repoPath, 'add', 'README.md']);
    await runCommand('git', ['-C', repoPath, 'commit', '-m', 'Initial commit']);
    await runCommand('git', ['-C', repoPath, 'branch', '-M', 'main']);
    await runCommand('git', ['-C', repoPath, 'push', '-u', 'origin', 'main']);

    return repoPath;
  }

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'test-'));
    workspaceRoot = join(tmpDir, 'workspace');
    runsRoot = join(tmpDir, 'runs');
    apiToken = 'test-token-continuation-cleanup';

    app = await buildApp({
      databasePath: ':memory:',
      workspaceRoot,
      runsRoot,
      apiToken,
      allowMockAgent: true,
      mockStepDelayMs: 5,
      maintenanceCleanupEnabled: true,
      terminalGracePeriodMs: 0,
      maintenanceIntervalMs: 3600_000,
    });
  });

  after(async () => {
    await app.app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should allow continuation after worktrees are cleaned', async () => {
    const repoPath = await setupRepository('test-repo');

    const projectResponse = await app.app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        name: 'Test Project',
        repositories: [{ name: 'test-repo', path: repoPath }],
      },
    });
    assert.equal(projectResponse.statusCode, 201);
    const project = JSON.parse(projectResponse.body);
    const repositoryId = project.repositories[0].id;

    const jobResponse = await app.app.inject({
      method: 'POST',
      url: '/jobs',
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        projectId: project.id,
        prompt: 'Make a test change',
        selectedRepositoryIds: [repositoryId],
        agent: 'mock',
        model: 'mock',
      },
    });
    assert.equal(jobResponse.statusCode, 201);
    const job = JSON.parse(jobResponse.body);

    await app.app.inject({
      method: 'POST',
      url: `/jobs/${job.id}/cancel`,
      headers: { authorization: `Bearer ${apiToken}` },
    });

    app.store.resolveScope(job.id, [repositoryId], [{ repositoryId, reason: 'Test setup' }]);
    await prepareRepositories(
      app.store.getJob(job.id)!,
      app.store.repositories([repositoryId]),
      workspaceRoot,
      runsRoot,
      (_type, _message, data) => app.store.recordRepositoryRun({ jobId: job.id, ...(data as any) })
    );

    app.store.setStatus(job.id, 'done');

    const runs = app.store.repositoryRuns(job.id);
    assert.equal(runs.length, 1);

    for (const run of runs) {
      app.store.removeRepositoryRun(job.id, run.repositoryId);
    }

    const runsAfterCleanup = app.store.repositoryRuns(job.id);
    assert.equal(runsAfterCleanup.length, 0);

    const reviewResponse = await app.app.inject({
      method: 'GET',
      url: `/jobs/${job.id}/changes`,
      headers: { authorization: `Bearer ${apiToken}` },
    });
    assert.equal(reviewResponse.statusCode, 200);
    const review = JSON.parse(reviewResponse.body);
    assert.equal(review.workspaceCleared, true);
    assert.equal(review.repositories.length, 0);

    const followUpResponse = await app.app.inject({
      method: 'POST',
      url: `/jobs/${job.id}/continue`,
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        message: 'Continue with another change',
        requestId: crypto.randomUUID(),
        scopeMode: 'manual',
        requestedRepositoryIds: [repositoryId],
      },
    });
    assert.equal(followUpResponse.statusCode, 201);
    const followUpJob = JSON.parse(followUpResponse.body);
    assert.equal(followUpJob.parentJobId, job.id);
    assert.equal(followUpJob.status, 'queued');
  });

  it('should preserve thread history and permissions after cleanup', async () => {
    const repoPathA = await setupRepository('test-repo-2a');
    const repoPathB = await setupRepository('test-repo-2b');

    const projectResponse = await app.app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        name: 'Test Project 2',
        repositories: [
          { name: 'repo-a', path: repoPathA },
          { name: 'repo-b', path: repoPathB },
        ],
      },
    });
    assert.equal(projectResponse.statusCode, 201);
    const project = JSON.parse(projectResponse.body);
    const repoAId = project.repositories[0].id;

    const jobResponse = await app.app.inject({
      method: 'POST',
      url: '/jobs',
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        projectId: project.id,
        prompt: 'First change',
        selectedRepositoryIds: [repoAId],
        agent: 'mock',
        model: 'mock',
      },
    });
    assert.equal(jobResponse.statusCode, 201);
    const firstJob = JSON.parse(jobResponse.body);

    await app.app.inject({
      method: 'POST',
      url: `/jobs/${firstJob.id}/cancel`,
      headers: { authorization: `Bearer ${apiToken}` },
    });

    app.store.resolveScope(firstJob.id, [repoAId], [{ repositoryId: repoAId, reason: 'Test setup' }]);
    await prepareRepositories(
      app.store.getJob(firstJob.id)!,
      app.store.repositories([repoAId]),
      workspaceRoot,
      runsRoot,
      (_type, _message, data) => app.store.recordRepositoryRun({ jobId: firstJob.id, ...(data as any) })
    );

    app.store.setStatus(firstJob.id, 'done');

    const runs = app.store.repositoryRuns(firstJob.id);
    for (const run of runs) {
      app.store.removeRepositoryRun(firstJob.id, run.repositoryId);
    }

    const followUpResponse = await app.app.inject({
      method: 'POST',
      url: `/jobs/${firstJob.id}/continue`,
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        message: 'Second change',
        requestId: crypto.randomUUID(),
        scopeMode: 'manual',
        requestedRepositoryIds: [repoAId],
      },
    });
    assert.equal(followUpResponse.statusCode, 201);
    const secondJob = JSON.parse(followUpResponse.body);
    assert.equal(secondJob.threadId, firstJob.threadId);
    assert.equal(secondJob.resolvedRepositoryIds.length, 1);
    assert.equal(secondJob.resolvedRepositoryIds[0], repoAId);

    const permissions = app.store.threadPermissions(secondJob.id);
    assert.ok(permissions.some((p) => p.repositoryId === repoAId && p.decision === 'approved'));
  });
});
