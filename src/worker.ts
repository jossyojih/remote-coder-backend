import { EventEmitter } from 'node:events';
import type { FastifyBaseLogger } from 'fastify';
import { Store } from './database.js';
import type { AgentAdapter, Job, JobEvent, Repository } from './types.js';

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

  constructor(private store: Store, private bus: JobEventBus, private adapters: Record<'mock' | 'codex' | 'claude', AgentAdapter>, private log: FastifyBaseLogger, private pollMs = 25) {}

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

  private emit(jobId: string, type: string, message: string, data?: unknown) { this.bus.publish(this.store.addEvent(jobId, type, message, data)); }

  private async tick() {
    if (this.stopping || this.active) return;
    const job = this.store.nextQueuedJob();
    if (!job || !this.store.claim(job.id)) return;
    const controller = new AbortController(); this.active = { jobId: job.id, controller };
    this.emit(job.id, 'status', 'Job started', { status: 'running' });
    try {
      const repositories = this.store.repositories(job.selectedRepositoryIds);
      if (repositories.length !== job.selectedRepositoryIds.length) throw new Error('One or more selected repositories no longer exist');
      await this.adapters[job.agent].run(job, repositories, (type, message, data) => this.emit(job.id, type, message, data), controller.signal);
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
