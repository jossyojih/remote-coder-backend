import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type { Store } from './database.js';
import type { Deployment, JobRepositoryRun } from './types.js';

export type DeploymentStarter = (id: string) => Promise<void>;

export function systemdDeploymentStarter(sudo = '/usr/bin/sudo'): DeploymentStarter {
  return (id) => new Promise((resolve, reject) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) return reject(new Error('Invalid deployment identifier'));
    execFile(sudo, ['/usr/bin/systemctl', 'start', '--no-block', `remote-coder-deploy@${id}.service`], { timeout: 10_000 }, (error) => error ? reject(error) : resolve());
  });
}

export class DeploymentCoordinator {
  constructor(private readonly store: Store, private readonly backendRepositoryPath: string | undefined, private readonly start: DeploymentStarter) {}

  async assertAvailable(run: JobRepositoryRun): Promise<void> {
    if (this.backendRepositoryPath && await realpath(run.sourcePath) === await realpath(this.backendRepositoryPath) && this.store.hasActiveDeployment()) throw new Error('Another backend deployment is already queued or deploying');
  }

  async enqueue(jobId: string, run: JobRepositoryRun, commitSha: string): Promise<Deployment | undefined> {
    if (!this.backendRepositoryPath || await realpath(run.sourcePath) !== await realpath(this.backendRepositoryPath)) return undefined;
    const created = this.store.createDeployment(jobId, run.repositoryId, commitSha, run);
    if (created.conflict === 'deployment_active') return undefined;
    const deployment = created.deployment!;
    if (deployment.status !== 'queued') return deployment;
    try { await this.start(deployment.id); }
    catch { this.store.updateDeployment(deployment.id, 'failed', 'handoff_failed', 'systemd_handoff_failed'); }
    return this.store.getDeployment(deployment.id);
  }
}
