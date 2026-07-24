import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type CommandCenterApp } from '../src/app.js';
import { runCommand, prepareRepositories } from '../src/agent-runtime.js';

describe('Repository validation before promotion', () => {
  let app: CommandCenterApp;
  let tmpDir: string;
  let apiToken: string;
  let workspaceRoot: string;
  let runsRoot: string;

  async function setupWithWorktree(validationCommands: Array<{ command: string; args: string[]; description: string }>, projectName = 'Test Project') {
    const repoRemote = join(workspaceRoot, `${projectName.replace(/\s/g, '-')}.git`);
    const repoPath = join(workspaceRoot, projectName.replace(/\s/g, '-'));

    await runCommand('git', ['init', '--bare', repoRemote]);
    await runCommand('git', ['clone', repoRemote, repoPath]);
    await runCommand('git', ['-C', repoPath, 'config', 'user.email', 'test@test.com']);
    await runCommand('git', ['-C', repoPath, 'config', 'user.name', 'Test']);

    await writeFile(join(repoPath, 'README.md'), 'test\n');
    await runCommand('git', ['-C', repoPath, 'add', 'README.md']);
    await runCommand('git', ['-C', repoPath, 'commit', '-m', 'Initial commit']);
    await runCommand('git', ['-C', repoPath, 'branch', '-M', 'main']);
    await runCommand('git', ['-C', repoPath, 'push', '-u', 'origin', 'main']);

    const projectResponse = await app.app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        name: projectName,
        repositories: [{ name: 'test-repo', path: repoPath }],
      },
    });
    const project = JSON.parse(projectResponse.body);
    const repositoryId = project.repositories[0].id;

    app.store.setValidationConfig(repositoryId, true, validationCommands);

    const jobResponse = await app.app.inject({
      method: 'POST',
      url: '/jobs',
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        projectId: project.id,
        prompt: 'Make a change',
        selectedRepositoryIds: [repositoryId],
        agent: 'mock',
        model: 'mock',
      },
    });
    const job = JSON.parse(jobResponse.body);

    await app.app.inject({
      method: 'POST',
      url: `/jobs/${job.id}/cancel`,
      headers: { authorization: `Bearer ${apiToken}` },
    });

    app.store.resolveScope(job.id, [repositoryId], [{ repositoryId, reason: 'Test setup' }]);
    const prepared = (await prepareRepositories(
      app.store.getJob(job.id)!,
      app.store.repositories([repositoryId]),
      workspaceRoot,
      runsRoot,
      (_type, _message, data) => app.store.recordRepositoryRun({ jobId: job.id, ...(data as any) })
    )).prepared;

    app.store.setStatus(job.id, 'done');

    return { project, repositoryId, job, prepared, repoPath };
  }

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'test-'));
    workspaceRoot = join(tmpDir, 'workspace');
    runsRoot = join(tmpDir, 'runs');
    apiToken = 'test-token-validation';

    app = await buildApp({
      databasePath: ':memory:',
      workspaceRoot,
      runsRoot,
      apiToken,
      allowMockAgent: true,
      mockStepDelayMs: 5,
    });
  });

  after(async () => {
    await app.app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should block promotion when validation fails', async () => {
    const { repositoryId, job, prepared } = await setupWithWorktree([
      { command: 'exit', args: ['1'], description: 'Failing test' },
    ], 'Project-Fail');

    appendFileSync(join(prepared[0].worktreePath, 'README.md'), 'change\n');

    const promoteResponse = await app.app.inject({
      method: 'POST',
      url: `/jobs/${job.id}/promotions`,
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        commitMessage: 'Test commit',
        approvedRepositoryIds: [repositoryId],
      },
    });
    assert.equal(promoteResponse.statusCode, 409);
    const promotion = JSON.parse(promoteResponse.body);
    assert.equal(promotion.status, 'failed');
    const failedRepo = promotion.repositories.find((r: any) => r.repositoryId === repositoryId);
    assert.ok(failedRepo);
    assert.equal(failedRepo.status, 'failed');
    assert.ok(failedRepo.error?.includes('Validation failed'));
  });

  it('should allow promotion when validation passes', async () => {
    const { repositoryId, job, prepared } = await setupWithWorktree([
      { command: 'echo', args: ['test'], description: 'Passing test' },
    ], 'Project-Pass');

    appendFileSync(join(prepared[0].worktreePath, 'README.md'), 'change\n');

    const promoteResponse = await app.app.inject({
      method: 'POST',
      url: `/jobs/${job.id}/promotions`,
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        commitMessage: 'Test commit',
        approvedRepositoryIds: [repositoryId],
      },
    });
    assert.equal(promoteResponse.statusCode, 200);
    const promotion = JSON.parse(promoteResponse.body);
    const repoStatus = promotion.repositories.find((r: any) => r.repositoryId === repositoryId);
    assert.ok(repoStatus);
    assert.equal(repoStatus.status, 'promoted');
  });

  it('should persist validation results for review', async () => {
    const { repositoryId, job, prepared } = await setupWithWorktree([
      { command: 'echo', args: ['test output'], description: 'Echo test' },
    ], 'Project-Results');

    appendFileSync(join(prepared[0].worktreePath, 'README.md'), 'change\n');

    const promoteResponse = await app.app.inject({
      method: 'POST',
      url: `/jobs/${job.id}/promotions`,
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        commitMessage: 'Test commit with results',
        approvedRepositoryIds: [repositoryId],
      },
    });
    assert.equal(promoteResponse.statusCode, 200);

    const promotion = app.store.getPromotion(job.id);
    assert.ok(promotion);
    const validationResults = app.store.getValidationResults(promotion.id);
    assert.equal(validationResults.length, 1);
    assert.equal(validationResults[0].repositoryId, repositoryId);
    assert.equal(validationResults[0].passed, true);
  });
});
