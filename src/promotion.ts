import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Store } from './database.js';
import { runCommand } from './agent-runtime.js';
import type { JobRepositoryRun, Promotion } from './types.js';
import type { DeploymentCoordinator } from './deployment.js';
import { validateRepositories, type ValidationResult } from './validation.js';

const MAX_DIFF_BYTES = 120_000;
const MAX_FILE_DIFF_BYTES = 32_000;

export class PromotionConflictError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function changedPaths(status: string): string[] {
  const entries = status.split('\0').filter(Boolean); const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!; const code = entry.slice(0, 2); let path = entry.slice(3);
    if (code.includes('R') || code.includes('C')) path = entries[++index] ?? path;
    paths.push(path);
  }
  return [...new Set(paths)];
}

function bounded(value: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value) <= max) return { text: value, truncated: false };
  let text = value; while (Buffer.byteLength(text) > max) text = text.slice(0, Math.floor(text.length * .9));
  return { text: `${text}\n… diff truncated …\n`, truncated: true };
}

async function diffStats(worktree: string, args: string[]): Promise<{ additions: number; deletions: number; changedFiles: number }> {
  const [numstat, names] = await Promise.all([
    runCommand('git', ['diff', '--numstat', '-z', ...args, '--'], worktree),
    runCommand('git', ['diff', '--name-only', '-z', ...args, '--'], worktree),
  ]);
  let additions = 0; let deletions = 0;
  for (const entry of numstat.stdout.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(entry);
    if (match) { additions += match[1] === '-' ? 0 : Number(match[1]); deletions += match[2] === '-' ? 0 : Number(match[2]); }
  }
  return { additions, deletions, changedFiles: names.stdout.split('\0').filter(Boolean).length };
}

export class PromotionService {
  constructor(private readonly store: Store, private readonly workspaceRoot: string, private readonly runsRoot: string, private readonly deployments?: DeploymentCoordinator) {}

  private async validateRun(run: JobRepositoryRun) {
    const workspace = await realpath(this.workspaceRoot); const runs = await realpath(this.runsRoot);
    const source = await realpath(run.sourcePath); const worktree = await realpath(run.worktreePath);
    if (!within(workspace, source) || !within(runs, worktree)) throw new PromotionConflictError('Retained worktree is outside configured boundaries', 'invalid_worktree');
    const repository = this.store.repositories([run.repositoryId])[0];
    if (!repository || await realpath(repository.path) !== source) throw new PromotionConflictError('Repository identity no longer matches the job', 'repository_changed');
    const common = await realpath(resolve(worktree, (await runCommand('git', ['rev-parse', '--git-common-dir'], worktree)).stdout.trim()));
    if (common !== await realpath(run.gitCommonDir)) throw new PromotionConflictError('Git worktree identity no longer matches the job', 'worktree_changed');
    const remoteUrl = (await runCommand('git', ['remote', 'get-url', run.remoteName], worktree)).stdout.trim();
    if (remoteUrl !== run.remoteUrl) throw new PromotionConflictError('Git remote configuration changed after the job started', 'remote_changed');
    return { source, worktree };
  }

  async review(jobId: string) {
    const job = this.store.getJob(jobId); if (!job) throw new PromotionConflictError('Job not found', 'not_found');
    if (job.status !== 'done') throw new PromotionConflictError('Only successfully completed jobs can be reviewed', 'job_not_done');
    const project = this.store.getProject(job.projectId); const runs = this.store.repositoryRuns(jobId);
    if (!project) throw new PromotionConflictError('Project not found', 'not_found');
    if (runs.length === 0) {
      return {
        jobId,
        promotion: this.store.getPromotion(jobId),
        repositories: [],
        hasChanges: false,
        workspaceCleared: true,
        limits: { totalDiffBytes: MAX_DIFF_BYTES, perFileDiffBytes: MAX_FILE_DIFF_BYTES },
      };
    }
    const repositories = [];
    for (const run of runs) {
      if (!job.resolvedRepositoryIds.includes(run.repositoryId) || !project.repositories.some((r) => r.id === run.repositoryId)) throw new PromotionConflictError('Repository is no longer owned by this job project', 'ownership_changed');
      await this.validateRun(run);
      const status = (await runCommand('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], run.worktreePath)).stdout;
      const paths = changedPaths(status); let totalBytes = 0; const files = [];
      for (const path of paths) {
        if (path.includes('\0') || isAbsolute(path) || path.split('/').includes('..')) throw new PromotionConflictError('Git returned an unsafe changed path', 'unsafe_path');
        let raw: string;
        if (status.includes(`?? ${path}\0`)) {
          const content = await readFile(resolve(run.worktreePath, path), 'utf8').catch(() => '[Binary or unreadable untracked file]\n');
          raw = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n${content.split('\n').map((line) => `+${line}`).join('\n')}`;
        } else raw = (await runCommand('git', ['diff', '--no-ext-diff', '--no-color', 'HEAD', '--', path], run.worktreePath)).stdout;
        const allowed = Math.max(0, Math.min(MAX_FILE_DIFF_BYTES, MAX_DIFF_BYTES - totalBytes)); const diff = bounded(raw, allowed); totalBytes += Buffer.byteLength(diff.text);
        const additions = raw.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
        const deletions = raw.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
        files.push({ path, additions, deletions, diff: diff.text, truncated: diff.truncated });
      }
      const repository = project.repositories.find((r) => r.id === run.repositoryId)!;
      repositories.push({ repositoryId: run.repositoryId, repositoryName: repository.name, effectivePromotionPolicy: repository.effectivePromotionPolicy, baseCommitSha: run.baseCommitSha, targetBranch: run.targetBranch, changedFiles: files, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0), hasChanges: files.length > 0 });
    }
    return { jobId, promotion: this.store.getPromotion(jobId), repositories, hasChanges: repositories.some((r) => r.hasChanges), limits: { totalDiffBytes: MAX_DIFF_BYTES, perFileDiffBytes: MAX_FILE_DIFF_BYTES } };
  }

  async promote(jobId: string, message: string, approvedIds: string[], automated = false): Promise<Promotion> {
    const review = await this.review(jobId); const changed = review.repositories.filter((r) => r.hasChanges).map((r) => r.repositoryId);
    const repositories = this.store.repositories(approvedIds);
    const allowedPolicy = automated ? 'auto_push' : 'review_required';
    if (repositories.length !== approvedIds.length || repositories.some((repository) => repository.effectivePromotionPolicy !== allowedPolicy)) {
      throw new PromotionConflictError(automated ? 'Only repositories with effective Auto-push policy can be auto-pushed' : 'Only repositories awaiting review can be promoted manually', 'policy_forbidden');
    }
    const runs = this.store.repositoryRuns(jobId).filter((r) => approvedIds.includes(r.repositoryId));
    const previous = this.store.getPromotion(jobId);
    if (!previous && approvedIds.some((id) => !changed.includes(id))) throw new PromotionConflictError('Only changed repositories owned by this completed job may be approved', 'invalid_approval');
    const started = this.store.beginPromotion(jobId, message, runs);
    if (started.conflict) throw new PromotionConflictError('A promotion already exists with different approval details', started.conflict);
    const existing = started.promotion!;
    const existingIds = existing.repositories.map((r) => r.repositoryId);
    if (approvedIds.some((id) => !existingIds.includes(id))) throw new PromotionConflictError('Approved repositories could not be added to the promotion', 'approval_mismatch');

    const validationConfigs = new Map(repositories.map((r) => [r.id, this.store.getValidationConfig(r.id)]));
    const validationResults = await validateRepositories(repositories, runs, validationConfigs);
    this.store.saveValidationResults(existing.id, validationResults);

    const failedValidation = validationResults.filter((r) => !r.passed);
    if (failedValidation.length > 0) {
      for (const result of failedValidation) {
        const failedCommand = result.results.find((cmd) => !cmd.passed);
        this.store.setPromotionRepository(jobId, result.repositoryId, 'failed', {
          error: failedCommand ? `Validation failed: ${failedCommand.description} (exit code ${failedCommand.exitCode})` : 'Validation failed',
        });
        this.store.addEvent(jobId, 'promotion_result', 'Repository promotion blocked by failing validation', {
          repositoryId: result.repositoryId,
          effectivePolicy: allowedPolicy,
          result: 'failed',
          validationFailed: true,
          failedCommand: failedCommand?.command,
        });
      }
      return this.store.getPromotion(jobId)!;
    }

    for (const run of runs) {
      const prior = existing.repositories.find((r) => r.repositoryId === run.repositoryId)!;
      if (prior.status !== 'promoted') await this.deployments?.assertAvailable(run);
    }
    for (const run of runs) {
      const prior = this.store.getPromotion(jobId)!.repositories.find((r) => r.repositoryId === run.repositoryId)!;
      if (prior.status === 'promoted') continue;
      this.store.setPromotionRepository(jobId, run.repositoryId, 'promoting');
      try {
        await this.validateRun(run);
        await runCommand('git', ['fetch', '--no-tags', run.remoteName, `+refs/heads/${run.targetBranch}:refs/remotes/${run.remoteName}/${run.targetBranch}`], run.worktreePath);
        const remoteSha = (await runCommand('git', ['rev-parse', '--verify', `${run.remoteName}/${run.targetBranch}^{commit}`], run.worktreePath)).stdout.trim();
        if (remoteSha !== run.baseCommitSha) throw new PromotionConflictError(`Remote ${run.targetBranch} advanced after this job started; start a new job from the latest remote commit`, 'stale_remote');
        const headBefore = (await runCommand('git', ['rev-parse', 'HEAD'], run.worktreePath)).stdout.trim();
        if (headBefore !== run.baseCommitSha) {
          this.store.setPromotionRepositoryStats(jobId, run.repositoryId, await diffStats(run.worktreePath, [run.baseCommitSha, headBefore]));
          await runCommand('git', ['merge-base', '--is-ancestor', run.baseCommitSha, headBefore], run.worktreePath);
          await runCommand('git', ['push', run.remoteName, `HEAD:refs/heads/${run.targetBranch}`], run.worktreePath);
          this.store.setPromotionRepository(jobId, run.repositoryId, 'promoted', { commitSha: headBefore }); await this.deployments?.enqueue(jobId, run, headBefore); continue;
        }
        await runCommand('git', ['add', '-A', '--'], run.worktreePath);
        const staged = (await runCommand('git', ['diff', '--cached', '--quiet', '--exit-code'], run.worktreePath).then(() => false, (error) => {
          if (error instanceof Error && error.message.includes('failed (1)')) return true; throw error;
        }));
        if (!staged) { this.store.setPromotionRepository(jobId, run.repositoryId, 'promoted', { commitSha: run.baseCommitSha }); continue; }
        this.store.setPromotionRepositoryStats(jobId, run.repositoryId, await diffStats(run.worktreePath, ['--cached']));
        await runCommand('git', ['commit', '--no-gpg-sign', '-m', message, '--'], run.worktreePath);
        const commitSha = (await runCommand('git', ['rev-parse', 'HEAD'], run.worktreePath)).stdout.trim();
        await runCommand('git', ['push', run.remoteName, `HEAD:refs/heads/${run.targetBranch}`], run.worktreePath);
        this.store.setPromotionRepository(jobId, run.repositoryId, 'promoted', { commitSha }); await this.deployments?.enqueue(jobId, run, commitSha);
      } catch (error) {
        const conflict = error instanceof PromotionConflictError;
        this.store.setPromotionRepository(jobId, run.repositoryId, 'failed', { error: error instanceof Error ? error.message : String(error), conflict });
      }
    }
    const completed = this.store.getPromotion(jobId)!;
    for (const result of completed.repositories.filter((item) => approvedIds.includes(item.repositoryId))) this.store.addEvent(jobId, 'promotion_result', result.status === 'promoted' ? (automated ? 'Repository auto-pushed' : 'Repository promoted after review') : 'Repository promotion failed', { repositoryId: result.repositoryId, effectivePolicy: allowedPolicy, result: result.status === 'promoted' ? (automated ? 'auto_pushed' : 'pushed_after_review') : 'failed', commitSha: result.commitSha, error: result.error, conflict: result.conflict });
    return completed;
  }

  async applyEffectivePolicies(jobId: string): Promise<void> {
    const job = this.store.getJob(jobId); if (!job) return;
    if (job.status !== 'done') {
      for (const repository of this.store.repositories(job.resolvedRepositoryIds.length ? job.resolvedRepositoryIds : job.requestedRepositoryIds)) {
        if (repository.effectivePromotionPolicy === 'read_only') {
          const run = this.store.repositoryRuns(jobId).find((item) => item.repositoryId === repository.id);
          if (run) try { await this.validateRun(run); await runCommand('git', ['reset', '--hard', run.baseCommitSha, '--'], run.worktreePath); await runCommand('git', ['clean', '-fd', '--'], run.worktreePath); }
          catch (error) { this.store.addEvent(jobId, 'promotion_result', 'Failed to discard read-only changes', { repositoryId: repository.id, effectivePolicy: 'read_only', result: 'failed', error: error instanceof Error ? error.message : String(error) }); }
        }
        this.store.addEvent(jobId, 'promotion_policy', `Promotion skipped because job ${job.status}`, { repositoryId: repository.id, repositoryName: repository.name, effectivePolicy: repository.effectivePromotionPolicy, result: 'not_eligible', jobStatus: job.status });
      }
      return;
    }
    let review: Awaited<ReturnType<PromotionService['review']>>;
    try { review = await this.review(jobId); }
    catch (error) {
      for (const repository of this.store.repositories(job.resolvedRepositoryIds)) this.store.addEvent(jobId, 'promotion_policy', 'Promotion policy evaluation failed', { repositoryId: repository.id, effectivePolicy: repository.effectivePromotionPolicy, result: 'failed', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const autoIds: string[] = [];
    for (const result of review.repositories) {
      const repository = this.store.repositories([result.repositoryId])[0]!;
      const outcome = !result.hasChanges ? 'no_changes' : repository.effectivePromotionPolicy === 'auto_push' ? 'auto_push_pending' : repository.effectivePromotionPolicy === 'read_only' ? 'read_only' : 'awaiting_review';
      this.store.addEvent(jobId, 'promotion_policy', `Promotion policy: ${outcome.replaceAll('_', ' ')}`, { repositoryId: repository.id, repositoryName: repository.name, effectivePolicy: repository.effectivePromotionPolicy, result: outcome });
      if (result.hasChanges && repository.effectivePromotionPolicy === 'auto_push') autoIds.push(repository.id);
      if (repository.effectivePromotionPolicy === 'read_only' && result.hasChanges) {
        const run = this.store.repositoryRuns(jobId).find((item) => item.repositoryId === repository.id)!;
        try {
          await this.validateRun(run);
          await runCommand('git', ['reset', '--hard', run.baseCommitSha, '--'], run.worktreePath);
          await runCommand('git', ['clean', '-fd', '--'], run.worktreePath);
          this.store.addEvent(jobId, 'promotion_result', 'Read-only changes discarded', { repositoryId: repository.id, effectivePolicy: 'read_only', result: 'read_only' });
        } catch (error) { this.store.addEvent(jobId, 'promotion_result', 'Failed to discard read-only changes', { repositoryId: repository.id, effectivePolicy: 'read_only', result: 'failed', error: error instanceof Error ? error.message : String(error) }); }
      }
    }
    if (!autoIds.length) return;
    try {
      await this.promote(jobId, `Remote Coder automatic changes for job ${jobId}`, autoIds, true);
    } catch (error) {
      for (const repositoryId of autoIds) this.store.addEvent(jobId, 'promotion_result', 'Repository auto-push failed', { repositoryId, effectivePolicy: 'auto_push', result: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
}
