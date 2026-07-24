import { readdir, stat, rm, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, basename } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Store } from './database.js';
import { runCommand } from './agent-runtime.js';
import type { AttachmentStorage } from './attachments.js';

export interface MaintenanceConfig {
  runsRoot: string;
  intervalMs: number;
  startupDelayMs: number;
  terminalGracePeriodMs: number;
  failedRetentionMs: number;
  diskWarningThreshold: number;
  batchLimit: number;
  cleanupEnabled: boolean;
}

export interface MaintenanceStatus {
  cleanupEnabled: boolean;
  lastRunAt?: string;
  lastRunCompletedAt?: string;
  nextRunAt?: string;
  isRunning: boolean;
  eligibleWorktrees: number;
  protectedWorktrees: number;
  lastCleanedCount: number;
  lastFailedCount: number;
  totalReclaimedBytes: number;
  diskUsageBytes?: number;
  archivedThreads: number;
  retainedWorktreeCount: number;
  retainedWorktreeBytes?: number;
  lastPreviewAt?: string;
}

export interface CleanupResult {
  jobId: string;
  repositoryId: string;
  worktreePath: string;
  reason: string;
  reclaimedBytes: number;
  cleanedAt: string;
}

export interface CleanupFailure {
  jobId: string;
  repositoryId: string;
  worktreePath: string;
  reason: string;
  errorCode: string;
  failedAt: string;
}

export type CleanupEligibility =
  | { eligible: false; reason: string }
  | { eligible: true; reason: string; reclaimedBytes: number };

const PREVIEW_OPERATION_TIMEOUT_MS = 3_000;
const PREVIEW_CONCURRENCY = 8;

type PreviewResult = {
  eligible: Array<{ jobId: string; repositoryId: string; worktreePath: string; reason: string; estimatedBytes: number }>;
  protectedWorktrees: Array<{ jobId: string; repositoryId: string; worktreePath: string; reason: string }>;
  retainedWorktreeCount: number;
  classifiedWorktreeCount: number;
  generatedAt?: string;
};

type RepositoryRun = ReturnType<Store['allRepositoryRuns']>[number];

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation timed out')), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function dirSize(path: string): Promise<number> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const fullPath = resolve(path, entry.name);
      if (entry.isDirectory()) {
        total += await dirSize(fullPath);
      } else if (entry.isFile()) {
        const stats = await stat(fullPath);
        total += stats.size;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

async function isRegisteredGitWorktree(path: string, sourcePath: string, runsRoot: string): Promise<boolean> {
  try {
    const resolved = realpathSync(path);
    if (!within(realpathSync(runsRoot), resolved)) return false;
    const commonDir = resolve(path, (await runCommand('git', ['rev-parse', '--git-common-dir'], path)).stdout.trim());
    const sourceCommonDir = resolve(sourcePath, (await runCommand('git', ['rev-parse', '--git-common-dir'], sourcePath)).stdout.trim());
    if (realpathSync(commonDir) !== realpathSync(sourceCommonDir)) return false;

    const listed = await runCommand('git', ['worktree', 'list', '--porcelain'], sourcePath);
    const registeredPaths = listed.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
    return registeredPaths.some((registeredPath) => {
      try {
        return realpathSync(registeredPath) === resolved;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

async function removeWorktree(worktreePath: string, sourcePath: string, runsRoot: string, log: FastifyBaseLogger): Promise<void> {
  const resolvedWorktree = realpathSync(worktreePath);
  const resolvedRunsRoot = realpathSync(runsRoot);

  if (!within(resolvedRunsRoot, resolvedWorktree)) {
    throw new Error('Worktree path is outside runs root');
  }

  if (realpathSync(sourcePath) === resolvedWorktree) {
    throw new Error('Cannot remove source repository');
  }

  try {
    await runCommand('git', ['worktree', 'remove', '--force', worktreePath], sourcePath);
    log.info({ worktreePath }, 'removed worktree via git worktree remove');
  } catch (error) {
    log.warn({ worktreePath, err: error }, 'git worktree remove failed, attempting filesystem cleanup');
    await rm(resolvedWorktree, { recursive: true, force: true });
  }

  try {
    await runCommand('git', ['worktree', 'prune'], sourcePath);
  } catch (error) {
    log.debug({ err: error }, 'git worktree prune had minor issues');
  }

  const branchName = basename(worktreePath).match(/remote-engineer\/[\w-]+/)?.[0];
  if (branchName) {
    try {
      const branches = await runCommand('git', ['branch', '--list', branchName], sourcePath);
      if (branches.stdout.includes(branchName)) {
        const current = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], sourcePath);
        if (current.stdout.trim() !== branchName) {
          await runCommand('git', ['branch', '-D', branchName], sourcePath);
          log.info({ branchName }, 'removed stale branch');
        }
      }
    } catch (error) {
      log.debug({ branchName, err: error }, 'branch cleanup had minor issues');
    }
  }
}

export class MaintenanceService {
  private status: MaintenanceStatus = {
    cleanupEnabled: false,
    isRunning: false,
    eligibleWorktrees: 0,
    protectedWorktrees: 0,
    lastCleanedCount: 0,
    lastFailedCount: 0,
    totalReclaimedBytes: 0,
    archivedThreads: 0,
    retainedWorktreeCount: 0,
  };
  private timer?: NodeJS.Timeout;
  private startupTimer?: NodeJS.Timeout;
  private started = false;
  private running = false;
  private cleanupHistory: CleanupResult[] = [];
  private failureHistory: CleanupFailure[] = [];
  private cachedPreview: PreviewResult = {
    eligible: [],
    protectedWorktrees: [],
    retainedWorktreeCount: 0,
    classifiedWorktreeCount: 0,
  };
  private worktreeSizeCache = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly config: MaintenanceConfig,
    private readonly log: FastifyBaseLogger,
    private readonly attachments?: AttachmentStorage,
    private readonly now: () => number = Date.now,
    private readonly maintenanceRunOverride?: () => Promise<void>,
    private readonly listWorktrees: (sourcePath: string, timeoutMs: number) => Promise<string> =
      async (sourcePath, timeoutMs) => (await runCommand('git', ['worktree', 'list', '--porcelain'], sourcePath, timeoutMs)).stdout,
  ) {
    this.status.cleanupEnabled = config.cleanupEnabled;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.status.nextRunAt = new Date(this.now() + this.config.startupDelayMs).toISOString();
    this.log.info({ intervalMs: this.config.intervalMs, startupDelayMs: this.config.startupDelayMs }, 'maintenance scheduler starting');

    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      void this.runMaintenance();
    }, this.config.startupDelayMs);
    this.startupTimer.unref();

    this.timer = setInterval(() => {
      void this.runMaintenance();
    }, this.config.intervalMs);

    this.timer.unref();
  }

  stop(): void {
    this.started = false;
    this.status.nextRunAt = undefined;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.log.info('maintenance scheduler stopped');
  }

  getStatus(): MaintenanceStatus {
    return { ...this.status };
  }

  async triggerMaintenance(): Promise<{ started: boolean; disabled?: boolean }> {
    if (!this.config.cleanupEnabled) {
      return { started: false, disabled: true };
    }
    if (this.running) {
      return { started: false };
    }
    void this.runMaintenance();
    return { started: true };
  }

  getCachedPreview(): PreviewResult {
    return structuredClone(this.cachedPreview);
  }

  async previewCleanup(): Promise<PreviewResult> {
    const runs = this.store.allRepositoryRuns();
    const eligible: Array<{ jobId: string; repositoryId: string; worktreePath: string; reason: string; estimatedBytes: number }> = [];
    const protectedWorktrees: Array<{ jobId: string; repositoryId: string; worktreePath: string; reason: string }> = [];

    const resolvedRunsRoot = await withTimeout(realpath(this.config.runsRoot), PREVIEW_OPERATION_TIMEOUT_MS);
    const sourcePaths = [...new Set(runs.map((run) => run.sourcePath))];
    const registrations = new Map<string, { paths?: Set<string>; reason?: string }>();
    await mapLimit(sourcePaths, 4, async (sourcePath) => {
      try {
        const sourceRealPath = await withTimeout(realpath(sourcePath), PREVIEW_OPERATION_TIMEOUT_MS);
        const listed = await withTimeout(this.listWorktrees(sourceRealPath, PREVIEW_OPERATION_TIMEOUT_MS), PREVIEW_OPERATION_TIMEOUT_MS);
        const paths = new Set(listed.split(/\r?\n/)
          .filter((line) => line.startsWith('worktree '))
          .map((line) => resolve(line.slice('worktree '.length))));
        registrations.set(sourcePath, { paths });
      } catch (error) {
        registrations.set(sourcePath, {
          reason: error instanceof Error && /timed out/i.test(error.message)
            ? 'git worktree verification timed out; protected by default'
            : 'source repository could not be verified; protected by default',
        });
      }
    });

    const classifications = await mapLimit(runs, PREVIEW_CONCURRENCY, async (run): Promise<CleanupEligibility> => {
      const job = this.store.getJob(run.jobId, true);
      if (job?.archivedAt) {
        return { eligible: false, reason: 'archived thread retained until archive purge' };
      }
      try {
        const resolvedWorktree = await withTimeout(realpath(run.worktreePath), PREVIEW_OPERATION_TIMEOUT_MS);
        if (!within(resolvedRunsRoot, resolvedWorktree)) {
          return { eligible: false, reason: 'worktree is outside the configured runs root' };
        }
        const registration = registrations.get(run.sourcePath);
        if (!registration || registration.reason) {
          return { eligible: false, reason: registration?.reason ?? 'worktree registration is unknown; protected by default' };
        }
        if (!registration.paths?.has(resolvedWorktree)) {
          return { eligible: false, reason: 'not a registered git worktree for its source repository' };
        }
        return this.checkMetadataEligibility(run);
      } catch (error) {
        return {
          eligible: false,
          reason: error instanceof Error && /timed out/i.test(error.message)
            ? 'worktree path verification timed out; protected by default'
            : 'worktree path could not be safely verified; protected by default',
        };
      }
    });

    for (const [index, run] of runs.entries()) {
      const result = classifications[index] ?? { eligible: false as const, reason: 'classification unavailable; protected by default' };
      if (result.eligible) {
        eligible.push({
          jobId: run.jobId,
          repositoryId: run.repositoryId,
          worktreePath: run.worktreePath,
          reason: result.reason,
          estimatedBytes: result.reclaimedBytes,
        });
      } else {
        protectedWorktrees.push({
          jobId: run.jobId,
          repositoryId: run.repositoryId,
          worktreePath: run.worktreePath,
          reason: result.reason,
        });
      }
    }

    const classifiedWorktreeCount = eligible.length + protectedWorktrees.length;
    const generatedAt = new Date(this.now()).toISOString();
    this.status.eligibleWorktrees = eligible.length;
    this.status.protectedWorktrees = protectedWorktrees.length;
    this.status.retainedWorktreeCount = runs.length;
    this.status.lastPreviewAt = generatedAt;
    this.cachedPreview = { eligible, protectedWorktrees, retainedWorktreeCount: runs.length, classifiedWorktreeCount, generatedAt };
    return structuredClone(this.cachedPreview);
  }

  private checkMetadataEligibility(run: RepositoryRun): CleanupEligibility {
    const job = this.store.getJob(run.jobId);
    if (!job) return { eligible: false, reason: 'job metadata is unavailable; protected by default' };
    if (['queued', 'running', 'needs_input'].includes(job.status)) {
      return { eligible: false, reason: 'job is active' };
    }
    if (this.store.activeDeploymentsForJob(run.jobId).length > 0) {
      return { eligible: false, reason: 'deployment in progress' };
    }
    const repository = this.store.repositories([run.repositoryId])[0];
    if (!repository) return { eligible: false, reason: 'repository metadata is unavailable; protected by default' };
    const promotion = this.store.getPromotion(run.jobId);
    const repositoryPromotion = promotion?.repositories.find((item) => item.repositoryId === run.repositoryId);
    const estimatedBytes = this.worktreeSizeCache.get(run.worktreePath) ?? 0;
    if (repositoryPromotion?.status === 'promoted') {
      return { eligible: true, reason: repository.effectivePromotionPolicy === 'auto_push' ? 'auto-pushed' : 'successfully promoted', reclaimedBytes: estimatedBytes };
    }
    if (repository.effectivePromotionPolicy === 'read_only' && job.status === 'done') {
      return { eligible: true, reason: 'read-only repository completed', reclaimedBytes: estimatedBytes };
    }
    if (['failed', 'cancelled'].includes(job.status)) {
      const retentionMs = job.status === 'failed' ? this.config.failedRetentionMs : this.config.terminalGracePeriodMs;
      if (this.now() >= new Date(job.updatedAt).getTime() + retentionMs) {
        return { eligible: true, reason: `${job.status} after retention period`, reclaimedBytes: estimatedBytes };
      }
      return { eligible: false, reason: `${job.status} within retention period` };
    }
    if (job.status === 'done') {
      return { eligible: false, reason: promotion ? 'promotion is not complete' : 'pending review; cleanliness is not verified during preview' };
    }
    return { eligible: false, reason: 'retention eligibility is unknown; protected by default' };
  }

  private async runMaintenance(): Promise<void> {
    if (this.running) {
      this.log.debug('maintenance already running, skipping');
      return;
    }

    this.running = true;
    this.status.isRunning = true;
    this.status.lastRunAt = new Date(this.now()).toISOString();
    this.status.nextRunAt = new Date(this.now() + this.config.intervalMs).toISOString();

    try {
      if (this.maintenanceRunOverride) {
        await this.maintenanceRunOverride();
      } else {
        if (this.config.cleanupEnabled) await this.purgeExpiredArchives();
        await this.cleanupWorktrees();
        await this.updateStorageMetrics();
      }

      this.status.lastRunCompletedAt = new Date(this.now()).toISOString();
      await this.previewCleanup();
      this.log.info({
        cleaned: this.status.lastCleanedCount,
        failed: this.status.lastFailedCount,
        totalReclaimed: this.status.totalReclaimedBytes,
      }, 'maintenance completed');
    } catch {
      this.log.error({ errorCode: 'MAINTENANCE_RUN_FAILED' }, 'maintenance run failed');
    } finally {
      this.running = false;
      this.status.isRunning = false;
    }
  }

  private async purgeExpiredArchives(): Promise<void> {
    const nowMs = this.now();
    for (const expired of this.store.expiredThreadRuns(nowMs)) {
      let safeToPurge = true;
      for (const run of expired.runs) {
        const target = resolve(run.worktreePath);
        const rel = relative(resolve(realpathSync(this.config.runsRoot)), target);
        if (!rel || rel.startsWith('..') || isAbsolute(rel) || resolve(run.sourcePath) === target) {
          this.log.error({ threadId: expired.threadId, worktreePath: run.worktreePath }, 'refusing to purge archived worktree outside runs root');
          safeToPurge = false;
          continue;
        }
        if (!await isRegisteredGitWorktree(run.worktreePath, run.sourcePath, this.config.runsRoot)) {
          this.log.error({ threadId: expired.threadId, worktreePath: run.worktreePath }, 'refusing to purge unregistered archived worktree');
          safeToPurge = false;
          continue;
        }
        try {
          await removeWorktree(run.worktreePath, run.sourcePath, this.config.runsRoot, this.log);
        } catch (error) {
          this.log.error({ threadId: expired.threadId, worktreePath: run.worktreePath, err: error }, 'failed to remove archived worktree');
          safeToPurge = false;
        }
      }
      if (safeToPurge) {
        if (this.attachments) {
          const threadAttachments = this.store.threadAttachments(expired.threadId);
          for (const { id, projectId } of threadAttachments) {
            try {
              this.attachments.deleteForThread(projectId, expired.threadId);
              this.log.info({ threadId: expired.threadId, projectId }, 'deleted attachments for purged thread');
              break;
            } catch (error) {
              this.log.error({ threadId: expired.threadId, projectId, err: error }, 'failed to delete attachments for purged thread');
            }
          }
        }
        this.store.purgeExpiredThread(expired.threadId, nowMs);
      }
    }
  }

  private async cleanupWorktrees(): Promise<void> {
    const runs = this.store.allRepositoryRuns();
    let cleaned = 0;
    let failed = 0;
    let eligible = 0;
    let protectedCount = 0;
    let reclaimed = 0;

    for (const run of runs) {
      if (this.config.cleanupEnabled && cleaned >= this.config.batchLimit) {
        this.log.info({ batchLimit: this.config.batchLimit }, 'batch limit reached, deferring remaining cleanup');
        break;
      }

      const job = this.store.getJob(run.jobId, true);
      if (job?.archivedAt) {
        continue;
      }

      const result = await this.checkEligibility(run.jobId, run);

      if (result.eligible) {
        eligible++;
        if (this.config.cleanupEnabled) {
          try {
            await removeWorktree(run.worktreePath, run.sourcePath, this.config.runsRoot, this.log);
            this.store.removeRepositoryRun(run.jobId, run.repositoryId);

            const cleanupResult: CleanupResult = {
              jobId: run.jobId,
              repositoryId: run.repositoryId,
              worktreePath: run.worktreePath,
              reason: result.reason,
              reclaimedBytes: result.reclaimedBytes,
              cleanedAt: new Date(this.now()).toISOString(),
            };

            this.cleanupHistory.push(cleanupResult);
            if (this.cleanupHistory.length > 100) this.cleanupHistory.shift();

            cleaned++;
            reclaimed += result.reclaimedBytes;
            this.log.info({ jobId: run.jobId, repositoryId: run.repositoryId, reason: result.reason }, 'cleaned worktree');
          } catch (error) {
            failed++;
            const failure: CleanupFailure = {
              jobId: run.jobId,
              repositoryId: run.repositoryId,
              worktreePath: run.worktreePath,
              reason: result.reason,
              errorCode: error instanceof Error ? (error.message.includes('ENOENT') ? 'not_found' : error.message.includes('outside') ? 'path_escape' : 'cleanup_failed') : 'unknown_error',
              failedAt: new Date(this.now()).toISOString(),
            };

            this.failureHistory.push(failure);
            if (this.failureHistory.length > 100) this.failureHistory.shift();

            this.log.error({ jobId: run.jobId, repositoryId: run.repositoryId, err: error }, 'failed to clean worktree');
          }
        }
      } else {
        protectedCount++;
      }
    }

    this.status.lastCleanedCount = cleaned;
    this.status.lastFailedCount = failed;
    this.status.eligibleWorktrees = eligible - cleaned;
    this.status.protectedWorktrees = protectedCount;
    this.status.totalReclaimedBytes += reclaimed;
  }

  private async checkEligibility(jobId: string, run: { jobId: string; repositoryId: string; worktreePath: string; sourcePath: string }): Promise<CleanupEligibility> {
    try {
      const resolvedWorktree = realpathSync(run.worktreePath);
      const resolvedRunsRoot = realpathSync(this.config.runsRoot);
      const resolvedSource = realpathSync(run.sourcePath);

      if (!within(resolvedRunsRoot, resolvedWorktree)) {
        return { eligible: false, reason: 'worktree outside runs root' };
      }

      if (resolvedWorktree === resolvedSource) {
        return { eligible: false, reason: 'worktree is source repository' };
      }

      if (!await isRegisteredGitWorktree(run.worktreePath, run.sourcePath, this.config.runsRoot)) {
        return { eligible: false, reason: 'not a registered git worktree' };
      }
    } catch {
      return { eligible: false, reason: 'path resolution failed' };
    }

    const job = this.store.getJob(jobId);
    if (!job) {
      return { eligible: false, reason: 'job not found' };
    }

    if (['queued', 'running', 'needs_input'].includes(job.status)) {
      return { eligible: false, reason: 'job is active' };
    }

    const activeDeployments = this.store.activeDeploymentsForJob(jobId);
    if (activeDeployments.length > 0) {
      return { eligible: false, reason: 'deployment in progress' };
    }

    const repository = this.store.repositories([run.repositoryId])[0];
    if (!repository) {
      return { eligible: false, reason: 'repository not found' };
    }

    const promotion = this.store.getPromotion(jobId);
    const repositoryPromotion = promotion?.repositories.find((r) => r.repositoryId === run.repositoryId);

    if (repositoryPromotion && repositoryPromotion.status === 'promoted') {
      const estimatedBytes = await dirSize(run.worktreePath);
      return { eligible: true, reason: 'successfully promoted', reclaimedBytes: estimatedBytes };
    }

    if (repository.effectivePromotionPolicy === 'auto_push' && repositoryPromotion?.status === 'promoted') {
      const estimatedBytes = await dirSize(run.worktreePath);
      return { eligible: true, reason: 'auto-pushed', reclaimedBytes: estimatedBytes };
    }

    if (repository.effectivePromotionPolicy === 'read_only' && job.status === 'done') {
      const estimatedBytes = await dirSize(run.worktreePath);
      return { eligible: true, reason: 'read-only repository completed', reclaimedBytes: estimatedBytes };
    }

    if (job.status === 'done') {
      try {
        const status = await runCommand('git', ['status', '--porcelain=v1', '-z'], run.worktreePath);
        if (!status.stdout.trim()) {
          const estimatedBytes = await dirSize(run.worktreePath);
          return { eligible: true, reason: 'completed with no changes', reclaimedBytes: estimatedBytes };
        }
      } catch {
        return { eligible: false, reason: 'cannot verify git status' };
      }
    }

    if (job.status === 'done' && !promotion) {
      return { eligible: false, reason: 'pending review' };
    }

    if (['failed', 'cancelled'].includes(job.status)) {
      const jobUpdatedAt = new Date(job.updatedAt).getTime();
      const retentionMs = job.status === 'failed' ? this.config.failedRetentionMs : this.config.terminalGracePeriodMs;
      const eligibleAfter = jobUpdatedAt + retentionMs;

      if (this.now() >= eligibleAfter) {
        const estimatedBytes = await dirSize(run.worktreePath);
        return { eligible: true, reason: `${job.status} after retention period`, reclaimedBytes: estimatedBytes };
      }

      return { eligible: false, reason: `${job.status} within retention period` };
    }

    return { eligible: false, reason: 'default protection' };
  }

  private async updateStorageMetrics(): Promise<void> {
    const runs = this.store.allRepositoryRuns();
    this.status.retainedWorktreeCount = runs.length;
    this.status.archivedThreads = this.store.archivedThreads(new Date(this.now()).toISOString()).length;

    try {
      let totalBytes = 0;
      const sizes = await mapLimit(runs, PREVIEW_CONCURRENCY, async (run) => {
        const size = await withTimeout(dirSize(run.worktreePath), PREVIEW_OPERATION_TIMEOUT_MS).catch(() => 0);
        this.worktreeSizeCache.set(run.worktreePath, size);
        return size;
      });
      totalBytes = sizes.reduce((sum, size) => sum + size, 0);
      this.status.retainedWorktreeBytes = totalBytes;

      this.status.diskUsageBytes = await withTimeout(dirSize(this.config.runsRoot), PREVIEW_OPERATION_TIMEOUT_MS);
    } catch (error) {
      this.log.debug({ err: error }, 'failed to update storage metrics');
    }
  }

  getCleanupHistory(limit = 20): CleanupResult[] {
    return this.cleanupHistory.slice(-limit).reverse();
  }

  getFailureHistory(limit = 20): CleanupFailure[] {
    return this.failureHistory.slice(-limit).reverse();
  }
}
