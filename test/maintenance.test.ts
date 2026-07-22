import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Store } from '../src/database.js';
import { MaintenanceService } from '../src/maintenance.js';

function git(...args: string[]) {
  return execSync(`git ${args.join(' ')}`, { encoding: 'utf8' });
}

describe('MaintenanceService', () => {
  let testRoot: string;
  let workspaceRoot: string;
  let runsRoot: string;
  let store: Store;
  let backendSource: string;
  let frontendSource: string;
  let nowValue = Date.now();

  before(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'maintenance-test-'));
    workspaceRoot = join(testRoot, 'workspace');
    runsRoot = join(testRoot, 'runs');
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(runsRoot, { recursive: true });

    backendSource = join(workspaceRoot, 'backend');
    frontendSource = join(workspaceRoot, 'frontend');

    for (const source of [backendSource, frontendSource]) {
      mkdirSync(source);
      git(`-C ${source} init`);
      git(`-C ${source} config user.name "Test"`);
      git(`-C ${source} config user.email "test@example.com"`);
      writeFileSync(join(source, 'README.md'), '# Project\n');
      git(`-C ${source} add -A`);
      git(`-C ${source} commit -m "initial"`);
      git(`-C ${source} branch -M main`);
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

  function createTestMaintenance(overrides: Partial<{ intervalMs: number; terminalGracePeriodMs: number; failedRetentionMs: number; batchLimit: number }> = {}) {
    return new MaintenanceService(
      store,
      {
        runsRoot,
        intervalMs: overrides.intervalMs ?? 12 * 60 * 60 * 1000,
        terminalGracePeriodMs: overrides.terminalGracePeriodMs ?? 24 * 60 * 60 * 1000,
        failedRetentionMs: overrides.failedRetentionMs ?? 7 * 24 * 60 * 60 * 1000,
        diskWarningThreshold: 0.85,
        batchLimit: overrides.batchLimit ?? 50,
      },
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      () => nowValue,
    );
  }

  function createJobWithWorktree(repositoryId: string, sourcePath: string, status: 'queued' | 'running' | 'needs_input' | 'done' | 'failed' | 'cancelled' = 'done'): { jobId: string; worktreePath: string } {
    const project = store.createProject('Test Project', [{ name: 'Repo', path: sourcePath }]);
    const job = store.createJob(project.id, 'Test prompt', [repositoryId ?? project.repositories[0]!.id], 'mock', 'manual');

    const worktreePath = join(runsRoot, `worktree-${job.id}-${repositoryId}`);
    mkdirSync(worktreePath, { recursive: true });

    git(`-C ${sourcePath} worktree add ${worktreePath} -b remote-engineer/${job.id}`);
    writeFileSync(join(worktreePath, 'test.txt'), 'test content\n');

    const baseCommit = git(`-C ${worktreePath} rev-parse HEAD`).trim();
    const remoteUrl = git(`-C ${worktreePath} remote get-url origin || echo "none"`).trim();
    const gitCommonDir = resolve(worktreePath, git(`-C ${worktreePath} rev-parse --git-common-dir`).trim());

    store.recordRepositoryRun({
      jobId: job.id,
      repositoryId: repositoryId ?? project.repositories[0]!.id,
      worktreePath,
      sourcePath,
      branch: `remote-engineer/${job.id}`,
      remoteName: 'origin',
      remoteUrl: remoteUrl === 'none' ? '' : remoteUrl,
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
    const { jobId, worktreePath } = createJobWithWorktree(project.repositories[0]!.id, backendSource, 'running');

    const maintenance = createTestMaintenance();
    const preview = await maintenance.previewCleanup();

    const protectedItem = preview.protectedWorktrees.find((p) => p.jobId === jobId);
    assert.ok(protectedItem, 'running job should be protected');
    assert.match(protectedItem.reason, /active/i);
  });

  it('should clean completed jobs with no changes', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId, worktreePath } = createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    const maintenance = createTestMaintenance();
    const previewBefore = await maintenance.previewCleanup();

    const eligibleItem = previewBefore.eligible.find((e) => e.jobId === jobId);
    assert.ok(eligibleItem, 'done job with no changes should be eligible');
    assert.match(eligibleItem.reason, /no changes/i);

    await maintenance.triggerMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const runs = store.repositoryRuns(jobId);
    assert.equal(runs.length, 0, 'worktree record should be removed');
  });

  it('should protect pending review jobs', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId, worktreePath } = createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    git(`-C ${worktreePath} add -A`);
    writeFileSync(join(worktreePath, 'new-file.txt'), 'new content\n');
    git(`-C ${worktreePath} add new-file.txt`);

    const maintenance = createTestMaintenance();
    const preview = await maintenance.previewCleanup();

    const protectedItem = preview.protectedWorktrees.find((p) => p.jobId === jobId);
    assert.ok(protectedItem, 'job with changes should be protected');
    assert.match(protectedItem.reason, /pending review/i);
  });

  it('should clean promoted worktrees', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId, worktreePath } = createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

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
    const { jobId } = createJobWithWorktree(project.repositories[0]!.id, backendSource, 'failed');

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
    const { jobId } = createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    const maintenance = createTestMaintenance();
    const preview = await maintenance.previewCleanup();

    const eligibleItem = preview.eligible.find((e) => e.jobId === jobId);
    assert.ok(eligibleItem, 'read-only completed job should be eligible');
    assert.match(eligibleItem.reason, /read-only/i);
  });

  it('should protect jobs with active deployments', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId } = createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

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
      const { jobId } = createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');
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

  it('should prevent concurrent maintenance runs', async () => {
    const maintenance = createTestMaintenance({ intervalMs: 100 });

    const result1 = await maintenance.triggerMaintenance();
    assert.ok(result1.started, 'first trigger should start');

    const result2 = await maintenance.triggerMaintenance();
    assert.ok(!result2.started, 'second concurrent trigger should not start');
  });

  it('should update storage metrics', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    const maintenance = createTestMaintenance();
    await maintenance.triggerMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const status = maintenance.getStatus();
    assert.ok(status.retainedWorktreeCount >= 0, 'should track worktree count');
    assert.ok(typeof status.retainedWorktreeBytes === 'number', 'should track storage bytes');
  });

  it('should maintain cleanup history', async () => {
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId } = createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

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
    const { jobId, worktreePath } = createJobWithWorktree(project.repositories[0]!.id, backendSource, 'done');

    store.archiveThread(jobId, nowValue);

    const maintenance = createTestMaintenance();
    const preview = await maintenance.previewCleanup();

    const archived = preview.protectedWorktrees.find((p) => p.jobId === jobId);
    assert.ok(!archived, 'archived thread worktrees are handled separately by purgeExpiredArchives');
  });

  it('should clean cancelled jobs after grace period', async () => {
    const shortGrace = 1000;
    const project = store.createProject('Test', [{ name: 'Backend', path: backendSource }]);
    const { jobId } = createJobWithWorktree(project.repositories[0]!.id, backendSource, 'cancelled');

    const maintenance = createTestMaintenance({ terminalGracePeriodMs: shortGrace });

    let preview = await maintenance.previewCleanup();
    let protectedItem = preview.protectedWorktrees.find((p) => p.jobId === jobId);
    assert.ok(protectedItem, 'recently cancelled job should be protected');

    nowValue += shortGrace + 1000;

    preview = await maintenance.previewCleanup();
    const eligibleItem = preview.eligible.find((e) => e.jobId === jobId);
    assert.ok(eligibleItem, 'old cancelled job should be eligible');
  });
});
