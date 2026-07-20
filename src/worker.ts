import { EventEmitter } from 'node:events';
import type { FastifyBaseLogger } from 'fastify';
import { Store } from './database.js';
import type { AgentAdapter, Job, JobEvent, Repository } from './types.js';
import { RepositoryScopePlanner } from './scope-planner.js';

export class JobEventBus extends EventEmitter {
  publish(event: JobEvent) { this.emit(event.jobId, event); }
}

export class MockAgentAdapter implements AgentAdapter {
  constructor(private readonly stepDelayMs = 40) {}

  async run(job: Job, _repositories: Repository[], emit: (type: string, message: string, data?: unknown) => void, signal: AbortSignal) {
    const steps = [
      ['analysis', 'Inspecting selected repositories'],
      ['progress', 'Planning requested changes'],
      ['progress', 'Applying implementation changes'],
      ['progress', 'Running verification checks'],
    ] as const;
    for (const [type, message] of steps) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.stepDelayMs);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      emit(type, message, { selectedRepositoryIds: job.selectedRepositoryIds });
    }
  }
}

export class JobWorker {
  private timer?: NodeJS.Timeout;
  private active?: { jobId: string; controller: AbortController };
  private stopping = false;

  constructor(private store: Store, private bus: JobEventBus, private adapters: Partial<Record<'mock' | 'codex' | 'claude', AgentAdapter>>, private log: FastifyBaseLogger, private pollMs = 25, private planner = new RepositoryScopePlanner()) {}

  start() { this.timer = setInterval(() => void this.tick(), this.pollMs); this.timer.unref(); void this.tick(); }
  wake() { void this.tick(); }

  cancel(jobId: string): boolean {
    const job = this.store.getJob(jobId);
    if (!job || !['queued', 'running', 'needs_input'].includes(job.status)) return false;
    this.store.setStatus(jobId, 'cancelled');
    this.emit(jobId, 'status', 'Job cancelled', { status: 'cancelled' });
    if (this.active?.jobId === jobId) this.active.controller.abort(new Error('cancelled'));
    return true;
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.active) this.active.controller.abort(new Error('shutdown'));
    while (this.active) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  private emit(jobId: string, type: string, message: string, data?: unknown) {
    if (type === 'worktree' && data && typeof data === 'object') this.store.recordRepositoryRun({ jobId, ...(data as Omit<import('./types.js').JobRepositoryRun, 'jobId'>) });
    this.bus.publish(this.store.addEvent(jobId, type, message, data));
  }

  private scopeRequired(job: Job): boolean {
    const event = this.store.events(job.id).filter((item) => item.type === 'scope_required').at(-1);
    if (!event) return false;
    // Manual scope is an exact user grant, not a starting point for expansion.
    // Likewise, "all" already grants the complete project. Only auto scope may
    // turn an agent's bounded-metadata discovery into an approval request.
    if (job.scopeMode !== 'auto') return false;
    const data = event.data as { suggestedRepositoryIds?: unknown; reasons?: unknown };
    const suggested = Array.isArray(data?.suggestedRepositoryIds) ? data.suggestedRepositoryIds.filter((id): id is string => typeof id === 'string') : [];
    if (!suggested.length || !this.store.repositoriesBelongTo(job.projectId, suggested)) throw new Error('Agent returned an invalid scope-required result');
    const supplied = Array.isArray(data.reasons) ? data.reasons as import('./types.js').ScopeReason[] : [];
    const reasons = suggested.map((repositoryId) => supplied.find((reason) => reason.repositoryId === repositoryId && typeof reason.reason === 'string' && reason.reason.trim()) ?? { repositoryId, reason: 'The selected scope was insufficient for the requested work.' });
    this.store.proposeScope(job.id, suggested, reasons, 'awaiting_correction');
    this.emit(job.id, 'status', 'Additional repository scope is required', { status: 'needs_input', suggestedRepositoryIds: suggested, reasons });
    return true;
  }

  private async tick() {
    if (this.stopping || this.active) return;
    const job = this.store.nextQueuedJob();
    if (!job || !this.store.claim(job.id)) return;
    const controller = new AbortController(); this.active = { jobId: job.id, controller };
    this.emit(job.id, 'status', 'Job started', { status: 'running' });
    try {
      let current = job;
      if (this.store.scopeState(job.id) === 'pending') {
        const project = this.store.getProject(job.projectId); if (!project) throw new Error('Project no longer exists');
        const plan = job.scopeMode === 'all'
          ? { repositoryIds: project.repositories.map((repository) => repository.id), reasons: project.repositories.map((repository) => ({ repositoryId: repository.id, reason: 'All repositories were explicitly granted for this job.' })) }
          : job.scopeMode === 'manual'
            ? { repositoryIds: job.requestedRepositoryIds, reasons: job.requestedRepositoryIds.map((repositoryId) => ({ repositoryId, reason: 'Explicitly selected for manual scope.' })) }
            : this.planner.plan(job.prompt.slice(0, 100_000), project.repositories);
        if (job.scopeMode === 'manual') {
          this.store.resolveScope(job.id, plan.repositoryIds, plan.reasons);
        } else this.store.resolveScope(job.id, plan.repositoryIds, plan.reasons);
        current = this.store.getJob(job.id)!;
        this.emit(job.id, 'scope_resolved', `Resolved repository scope to ${current.resolvedRepositoryIds.length} repository${current.resolvedRepositoryIds.length === 1 ? '' : 'ies'}`, { scopeMode: current.scopeMode, requestedRepositoryIds: current.requestedRepositoryIds, resolvedRepositoryIds: current.resolvedRepositoryIds, reasons: current.scopeReasons });
      }
      const project = this.store.getProject(current.projectId); if (!project) throw new Error('Project no longer exists');
      const candidates = current.scopeMode === 'manual'
        ? project.repositories.filter((repository) => current.resolvedRepositoryIds.includes(repository.id))
        : project.repositories;
      current = { ...current, repositoryScopeCandidates: candidates.map((repository) => ({ repositoryId: repository.id, repositoryName: repository.name, role: this.planner.describe(repository) })) };
      const repositories = this.store.repositories(current.resolvedRepositoryIds);
      if (repositories.length !== current.resolvedRepositoryIds.length || repositories.length === 0) throw new Error('Resolved repository scope is empty or invalid');
      const adapter = this.adapters[current.agent]; if (!adapter) throw new Error(`Agent ${current.agent} is not available`);
      await adapter.run(current, repositories, (type, message, data) => {
        if (type === 'scope_required' && current.scopeMode !== 'auto') return;
        this.emit(job.id, type, message, data);
      }, controller.signal);
      if (this.scopeRequired(current)) return;
      if (this.store.getJob(job.id)?.status === 'running') {
        this.store.setStatus(job.id, 'done');
        this.emit(job.id, 'status', 'Job completed', { status: 'done' });
      }
    } catch (error) {
      if (this.store.getJob(job.id)?.status !== 'cancelled' && !this.stopping) {
        this.store.setStatus(job.id, 'failed');
        this.emit(job.id, 'error', 'Job failed', { status: 'failed', error: error instanceof Error ? error.message : String(error) });
        this.log.error({ err: error, jobId: job.id }, 'worker job failed');
      }
    } finally { this.active = undefined; }
  }
}
