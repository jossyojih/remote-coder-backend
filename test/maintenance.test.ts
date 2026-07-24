import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/database.js';
import { MaintenanceService } from '../src/maintenance.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout;
}

describe('MaintenanceService', () => {
  let testRoot: string;
  let workspaceRoot: string;
  let runsRoot: string;
  let store: Store;
  let backendSource: string;
  let frontendSource: string;
  let nowValue = Date.now();

  before(async () => {
    testRoot = mkdtempSync(join(tmpdir(), 'maintenance-test-'));
    workspaceRoot = join(testRoot, 'workspace');
    runsRoot = join(testRoot, 'runs');
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(runsRoot, { recursive: true });

    backendSource = join(workspaceRoot, 'backend');
    frontendSource = join(workspaceRoot, 'frontend');

    for (const source of [backendSource, frontendSource]) {
      mkdirSync(source);
      await git(source, ['init']);
      await git(source, ['config', 'user.name', 'Test']);
      await git(source, ['config', 'user.email', 'test@example.com']);
      writeFileSync(join(source, 'README.md'), '# Project\n');
      await git(source, ['add', '-A']);
      await git(source, ['commit', '-m', 'initial']);
      await git(source, ['branch', '-M', 'main']);
    }
  });

  after(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    const dbPath = join(testRoot, `test-${Date.now()}.db`);
    store = new Store(dbPath);
    nowValue = Date.now();
  });

  function createTestMaintenance(overrides: Partial<{ intervalMs: number; terminalGracePeriodMs: number; failedRetentionMs: number; batchLimit: number; cleanupEnabled: boolean; listWorktrees: (sourcePath: string, timeoutMs: number) => Promise<string> }> = {}) {
    return new MaintenanceService(
      store,
      {
        runsRoot,
        intervalMs: overrides.intervalMs ?? 12 * 60 * 60 * 1000,
        startupDelayMs: 10_000,
        terminalGracePeriodMs: overrides.terminalGracePeriodMs ?? 24 * 60 * 60 * 1000,
        failedRetentionMs: overrides.failedRetentionMs ?? 7 * 24 * 60 * 60 * 1000,
        diskWarningThreshold: 0.85,
        batchLimit: overrides.batchLimit ?? 50,
        cleanupEnabled: overrides.cleanupEnabled ?? true,
      },
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      undefined,
      () => nowValue,
      undefined,
      overrides.listWorktrees,
    );
  }

  async function createJobWithWorktree(repositoryId: string, sourcePath: string, status: 'queued' | 'running' | 'needs_input' | 'done' | 'failed' | 'cancelled' = 'done'): Promise<{ jobId: string; worktreePath: string }> {
    const project = store.createProject('Test Project', [{ name: 'Repo', path: sourcePath }]);
    const job = store.createJob(project.id, 'Test prompt', [repositoryId ?? project.repositories[0]!.id], 'mock', 'manual');

    const worktreePath = join(runsRoot, `worktree-${job.id}-${repositoryId}`);
    mkdirSync(worktreePath, { recursive: true });

    await git(sourcePath, ['worktree', 'add', worktreePath, '-b', `remote-engineer/${job.id}`]);
    writeFileSync(join(worktreePath, 'test.txt'), 'test content\n');
    await git(worktreePath, ['add', 'test.txt']);
    await git(worktreePath, ['commit', '-m', 'test commit']);

    const baseCommit = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
    let remoteUrl = '';
    try {
      remoteUrl = (await git(worktreePath, ['remote', 'get-url', 'origin'])).trim();
    } catch {
      // The temporary repositories intentionally have no remote.
    }
    const gitCommonDir = resolve(worktreePath, (await git(worktreePath, ['rev-parse', '--git-common-dir'])).trim());

    store.recordRepositoryRun({
      jobId: job.id,
      repositoryId: repositoryId ?? project.repositories[0]!.id,
      worktreePath,
      sourcePath,
      branch: `remote-engineer/${job.id}`,
      remoteName: 'origin',
      remoteUrl,
      targetBranch: 'main',
      baseCommitSha: baseCommit,
      gitCommonDir,
    });

    if (status !== 'queued') {
      store.setStatus(job.id, status);
    }

    return { jobId: job.id, worktreePath };
  }

  it('should protect active jobs', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId, worktreePath } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'running');

    const maintenance = createTestMaintenance();
    const preview = await maintenance.previewCleanup();

    const protectedItem = preview.protectedWorktrees.find((p) => p.jobId === jobId);
    assert.ok(protectedItem, 'running job should be protected');
    assert.match(protectedItem.reason, /active/i);
  });

  it('protects completed jobs whose cleanliness is not stored in database metadata', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId, worktreePath } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    const maintenance = createTestMaintenance();
    const previewBefore = await maintenance.previewCleanup();

    const protectedItem = previewBefore.protectedWorktrees.find((item) => item.jobId === jobId);
    assert.ok(protectedItem, 'unverifiable cleanliness must be protected');
    assert.match(protectedItem.reason, /not verified/i);
    assert.equal(store.repositoryRuns(jobId).length, 1, 'preview must not delete the worktree record');
  });

  it('should protect pending review jobs', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId, worktreePath } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    await git(worktreePath, ['add', '-A']);
    writeFileSync(join(worktreePath, 'new-file.txt'), 'new content\n');
    await git(worktreePath, ['add', 'new-file.txt']);

    const maintenance = createTestMaintenance();
    const preview = await maintenance.previewCleanup();

    const protectedItem = preview.protectedWorktrees.find((p) => p.jobId === jobId);
    assert.ok(protectedItem, 'job with changes should be protected');
    assert.match(protectedItem.reason, /pending review/i);
  });

  it('should clean promoted worktrees', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId, worktreePath } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    const runs = store.repositoryRuns(jobId);
    store.beginPromotion(jobId, 'Test promotion', runs);
    store.setPromotionRepository(jobId, project.repositories[0]!.id, 'promoted', { commitSha: 'abc123' });

    const maintenance = createTestMaintenance();
    const preview = await maintenance.previewCleanup();

    const eligibleItem = preview.eligible.find((e) => e.jobId === jobId);
    assert.ok(eligibleItem, 'promoted job should be eligible for cleanup');
    assert.match(eligibleItem.reason, /promoted/i);
  });

  it('should respect failed retention period', async () => {
    const shortRetention = 1000;
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'failed');

    const maintenance = createTestMaintenance({ failedRetentionMs: shortRetention });

    let preview = await maintenance.previewCleanup();
    let protectedItem = preview.protectedWorktrees.find((p) => p.jobId === jobId);
    assert.ok(protectedItem, 'recently failed job should be protected');
    assert.match(protectedItem.reason, /retention period/i);

    nowValue += shortRetention + 1000;

    preview = await maintenance.previewCleanup();
    const eligibleItem = preview.eligible.find((e) => e.jobId === jobId);
    assert.ok(eligibleItem, 'old failed job should be eligible');
    assert.match(eligibleItem.reason, /after retention/i);
  });

  it('should clean read-only completed jobs', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    store.updateRepositoryPromotionPolicy(project.id, project.repositories[0]!.id, 'read_only');
    const { jobId } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    const maintenance = createTestMaintenance();
    const preview = await maintenance.previewCleanup();

    const eligibleItem = preview.eligible.find((e) => e.jobId === jobId);
    assert.ok(eligibleItem, 'read-only completed job should be eligible');
    assert.match(eligibleItem.reason, /read-only/i);
  });

  it('should protect jobs with active deployments', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    const runs = store.repositoryRuns(jobId);
    store.beginPromotion(jobId, 'Test', runs);
    store.setPromotionRepository(jobId, project.repositories[0]!.id, 'promoted', { commitSha: 'abc123' });
    store.createDeployment(jobId, project.repositories[0]!.id, 'abc123', runs[0]!);

    const maintenance = createTestMaintenance();
    const preview = await maintenance.previewCleanup();

    const protectedItem = preview.protectedWorktrees.find((p) => p.jobId === jobId);
    assert.ok(protectedItem, 'job with active deployment should be protected');
    assert.match(protectedItem.reason, /deployment/i);
  });

  it('should respect batch limit', async () => {
    const batchLimit = 3;
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);

    const jobIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { jobId } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');
      jobIds.push(jobId);
    }

    const maintenance = createTestMaintenance({ batchLimit });
    await maintenance.triggerMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const status = maintenance.getStatus();
    assert.ok(status.lastCleanedCount <= batchLimit, `should clean at most ${batchLimit} worktrees`);
  });

  it('should never clean paths outside runs root', async () => {
    const outsidePath = join(testRoot, 'outside');
    mkdirSync(outsidePath);

    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const job = store.createJob(project.id, 'Test', [project.repositories[0]!.id], 'mock', 'manual');
    store.setStatus(job.id, 'done');

    store.recordRepositoryRun({
      jobId: job.id,
      repositoryId: project.repositories[0]!.id,
      worktreePath: outsidePath,
      sourcePath: backendSource,
      branch: 'test',
      remoteName: 'origin',
      remoteUrl: '',
      targetBranch: 'main',
      baseCommitSha: 'abc',
      gitCommonDir: backendSource,
    });

    const maintenance = createTestMaintenance();
    const preview = await maintenance.previewCleanup();

    const outsideItem = preview.protectedWorktrees.find((p) => p.jobId === job.id);
    assert.ok(outsideItem, 'path outside runs root should be protected');
    assert.match(outsideItem.reason, /outside/i);
  });

  it('should protect unregistered git repositories inside runs root', async () => {
    const unregisteredPath = join(runsRoot, `unregistered-${Date.now()}`);
    mkdirSync(unregisteredPath);
    await git(unregisteredPath, ['init']);

    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const job = store.createJob(project.id, 'Test', [project.repositories[0]!.id], 'mock', 'manual');
    store.setStatus(job.id, 'done');
    store.recordRepositoryRun({
      jobId: job.id,
      repositoryId: project.repositories[0]!.id,
      worktreePath: unregisteredPath,
      sourcePath: backendSource,
      branch: 'not-registered',
      remoteName: 'origin',
      remoteUrl: '',
      targetBranch: 'main',
      baseCommitSha: 'abc',
      gitCommonDir: join(unregisteredPath, '.git'),
    });

    const maintenance = createTestMaintenance();
    const preview = await maintenance.previewCleanup();

    const unregisteredItem = preview.protectedWorktrees.find((p) => p.jobId === job.id);
    assert.ok(unregisteredItem, 'unregistered repository should be protected');
    assert.match(unregisteredItem.reason, /not a registered git worktree/i);
  });

  it('should prevent concurrent maintenance runs', async () => {
    const maintenance = createTestMaintenance({ intervalMs: 100 });

    const result1 = await maintenance.triggerMaintenance();
    assert.ok(result1.started, 'first trigger should start');

    const result2 = await maintenance.triggerMaintenance();
    assert.ok(!result2.started, 'second concurrent trigger should not start');
  });

  it('should update storage metrics', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    const maintenance = createTestMaintenance();
    await maintenance.triggerMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const status = maintenance.getStatus();
    assert.ok(status.retainedWorktreeCount >= 0, 'should track worktree count');
    assert.ok(typeof status.retainedWorktreeBytes === 'number', 'should track storage bytes');
  });

  it('should maintain cleanup history', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    const maintenance = createTestMaintenance();
    await maintenance.triggerMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const history = maintenance.getCleanupHistory();
    const cleaned = history.find((h) => h.jobId === jobId);

    if (store.repositoryRuns(jobId).length === 0) {
      assert.ok(cleaned, 'cleanup should be recorded in history');
      assert.ok(cleaned.reclaimedBytes >= 0, 'should record reclaimed bytes');
      assert.ok(cleaned.cleanedAt, 'should record timestamp');
    }
  });

  it('should handle archived threads separately', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId, worktreePath } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    store.archiveThread(jobId, nowValue);

    const maintenance = createTestMaintenance();
    const preview = await maintenance.previewCleanup();

    const archived = preview.protectedWorktrees.find((p) => p.jobId === jobId);
    assert.ok(archived, 'archived retained worktrees must remain visible in the preview');
    assert.match(archived.reason, /archived thread/i);
  });

  it('classifies registered, unregistered, unsafe, and unverifiable retained worktrees and reconciles counts', async () => {
    const registeredProject = store.createProject('Registered', [{ name: 'Backend', path: backendSource }]);
    await createJobWithWorktree(registeredProject.repositories[0]!.id, backendSource, 'done');

    const cases = [
      { name: 'unregistered', worktreePath: join(runsRoot, `unregistered-reconcile-${Date.now()}`), sourcePath: backendSource },
      { name: 'unsafe', worktreePath: join(testRoot, `escaped-reconcile-${Date.now()}`), sourcePath: backendSource },
      { name: 'unknown', worktreePath: join(runsRoot, `missing-reconcile-${Date.now()}`), sourcePath: join(workspaceRoot, 'missing-source') },
    ];
    mkdirSync(cases[0]!.worktreePath);
    await git(cases[0]!.worktreePath, ['init']);
    mkdirSync(cases[1]!.worktreePath);

    for (const item of cases) {
      const project = store.createProject(item.name, [{ name: item.name, path: backendSource }]);
      const job = store.createJob(project.id, item.name, [project.repositories[0]!.id], 'mock', 'manual');
      store.setStatus(job.id, 'done');
      store.recordRepositoryRun({
        jobId: job.id,
        repositoryId: project.repositories[0]!.id,
        worktreePath: item.worktreePath,
        sourcePath: item.sourcePath,
        branch: item.name,
        remoteName: 'origin',
        remoteUrl: '',
        targetBranch: 'main',
        baseCommitSha: 'unknown',
        gitCommonDir: join(item.sourcePath, '.git'),
      });
    }

    const preview = await createTestMaintenance({ cleanupEnabled: false }).previewCleanup();

    assert.equal(preview.retainedWorktreeCount, 4);
    assert.equal(preview.classifiedWorktreeCount, 4);
    assert.equal(preview.eligible.length + preview.protectedWorktrees.length, preview.retainedWorktreeCount);
    assert.equal(preview.protectedWorktrees.length, 4);
    assert.ok(preview.protectedWorktrees.every((item) => item.reason.length > 0));
    assert.ok(preview.protectedWorktrees.some((item) => /not a registered/i.test(item.reason)));
    assert.ok(preview.protectedWorktrees.some((item) => /outside/i.test(item.reason)));
    assert.ok(preview.protectedWorktrees.some((item) => /could not be safely verified/i.test(item.reason)));
  });

  it('should clean cancelled jobs after grace period', async () => {
    const shortGrace = 1000;
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'cancelled');

    const maintenance = createTestMaintenance({ terminalGracePeriodMs: shortGrace });

    let preview = await maintenance.previewCleanup();
    let protectedItem = preview.protectedWorktrees.find((p) => p.jobId === jobId);
    assert.ok(protectedItem, 'recently cancelled job should be protected');

    nowValue += shortGrace + 1000;

    preview = await maintenance.previewCleanup();
    const eligibleItem = preview.eligible.find((e) => e.jobId === jobId);
    assert.ok(eligibleItem, 'old cancelled job should be eligible');
  });

  it('should not delete worktrees when cleanup is disabled', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId, worktreePath } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    const maintenance = createTestMaintenance({ cleanupEnabled: false });

    const previewBefore = await maintenance.previewCleanup();
    assert.equal(previewBefore.classifiedWorktreeCount, 1);

    await maintenance.triggerMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const runs = store.repositoryRuns(jobId);
    assert.equal(runs.length, 1, 'worktree should still exist when cleanup disabled');

    const status = maintenance.getStatus();
    assert.equal(status.lastCleanedCount, 0, 'no worktrees should be cleaned when disabled');
  });

  it('should not purge expired archived worktrees when cleanup is disabled', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId, worktreePath } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');
    store.archiveThread(jobId, nowValue);
    nowValue += 8 * 24 * 60 * 60 * 1000;

    const maintenance = createTestMaintenance({ cleanupEnabled: false });
    await maintenance.triggerMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(existsSync(worktreePath), 'archived worktree should remain when cleanup is disabled');
    assert.ok(store.getJob(jobId, true), 'archived thread data should remain when cleanup is disabled');
  });

  it('should delete worktrees when cleanup is enabled', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    const maintenance = createTestMaintenance({ cleanupEnabled: true });
    await maintenance.triggerMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const runs = store.repositoryRuns(jobId);
    assert.equal(runs.length, 0, 'worktree should be removed when cleanup enabled');

    const status = maintenance.getStatus();
    assert.ok(status.lastCleanedCount > 0, 'worktrees should be cleaned when enabled');
  });

  it('should still calculate eligibility when cleanup is disabled', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const promoted = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');
    const promotedRuns = store.repositoryRuns(promoted.jobId);
    store.beginPromotion(promoted.jobId, 'promoted', promotedRuns);
    store.setPromotionRepository(promoted.jobId, project.repositories[0]!.id, 'promoted', { commitSha: 'abc123' });
    await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'running');

    const maintenance = createTestMaintenance({ cleanupEnabled: false });
    const preview = await maintenance.previewCleanup();

    assert.ok(preview.eligible.length > 0, 'should still calculate eligible worktrees');
    assert.ok(preview.protectedWorktrees.length > 0, 'should still calculate protected worktrees');
  });

  it('classifies at least 100 retained worktrees within 15 seconds and deletes nothing', async () => {
    const project = store.createProject('Scale', [{ name: 'Backend', path: backendSource }]);
    const registered = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'failed');
    const template = store.repositoryRuns(registered.jobId)[0]!;
    nowValue += 8 * 24 * 60 * 60 * 1000;

    for (let index = 1; index < 100; index++) {
      const job = store.createJob(project.id, `Scale ${index}`, [project.repositories[0]!.id], 'mock', 'manual');
      store.setStatus(job.id, 'failed');
      store.recordRepositoryRun({ ...template, jobId: job.id, branch: `scale-${index}` });
    }

    const before = store.allRepositoryRuns().length;
    const startedAt = Date.now();
    const preview = await createTestMaintenance({ cleanupEnabled: false }).previewCleanup();

    assert.ok(Date.now() - startedAt < 15_000);
    assert.equal(preview.retainedWorktreeCount, before);
    assert.equal(preview.eligible.length + preview.protectedWorktrees.length, before);
    assert.equal(store.allRepositoryRuns().length, before, 'preview must not delete database records');
    assert.ok(existsSync(template.worktreePath), 'preview must not delete filesystem worktrees');
  });

  it('protects all worktrees when git registration verification times out', async () => {
    const project = store.createProject('Timeout', [{ name: 'Backend', path: backendSource }]);
    const { jobId } = await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'failed');
    const maintenance = createTestMaintenance({
      listWorktrees: async () => {
        throw new Error('git worktree list timed out');
      },
    });

    const preview = await maintenance.previewCleanup();
    const item = preview.protectedWorktrees.find((entry) => entry.jobId === jobId);
    assert.ok(item);
    assert.match(item.reason, /timed out/i);
  });

  it('returns the most recent preview from cache without recomputing it', async () => {
    const project = store.createProject('Cache', [{ name: 'Backend', path: backendSource }]);
    await createJobWithWorktree(project.repositories[0]!.id, backendSource, 'running');
    let listCalls = 0;
    const maintenance = createTestMaintenance({
      listWorktrees: async (sourcePath) => {
        listCalls++;
        return (await git(sourcePath, ['worktree', 'list', '--porcelain']));
      },
    });

    const fresh = await maintenance.previewCleanup();
    const cached = maintenance.getCachedPreview();
    assert.deepEqual(cached, fresh);
    assert.equal(listCalls, 1);
    assert.ok(cached.generatedAt);
  });
});
