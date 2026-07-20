#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const id = process.argv[2];
const api = process.env.DEPLOYMENT_API_URL ?? 'http://127.0.0.1:4000';
const token = process.env.DEPLOYMENT_API_TOKEN;
if (!id || !/^[0-9a-f-]{36}$/.test(id) || !token) process.exit(2);
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const request = async (path, body) => {
  const response = await fetch(`${api}${path}`, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`api_${response.status}`);
  return response.json();
};
const state = (status, stage, errorCode) => request(`/internal/deployments/${id}/state`, { status, stage, ...(errorCode ? { errorCode } : {}) });
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: 'ignore', timeout: 30 * 60_000 });
  if (result.error || result.status !== 0) throw new Error(command === 'npm' ? `npm_${args[0]}` : `${command}_${args[0]}`);
};
const health = async () => {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { const response = await fetch(`${api}/health`, { signal: AbortSignal.timeout(2_000) }); if (response.ok && (await response.json()).status === 'ok') return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('health_check');
};
let deployment; let previous; let changed = false;
try {
  deployment = await request(`/internal/deployments/${id}/claim`);
  const cwd = deployment.sourcePath;
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (status.status !== 0 || status.stdout !== '') throw new Error('worktree_not_clean');
  previous = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).stdout.trim();
  await state('deploying', 'fetching');
  run('git', ['fetch', '--no-tags', deployment.remoteName, `+refs/heads/${deployment.targetBranch}:refs/remotes/${deployment.remoteName}/${deployment.targetBranch}`], cwd);
  run('git', ['cat-file', '-e', `${deployment.commitSha}^{commit}`], cwd);
  run('git', ['merge-base', '--is-ancestor', deployment.commitSha, `${deployment.remoteName}/${deployment.targetBranch}`], cwd);
  run('git', ['checkout', '--detach', deployment.commitSha], cwd); changed = true;
  await state('deploying', 'installing'); run('npm', ['ci'], cwd);
  await state('deploying', 'testing'); run('npm', ['test'], cwd);
  await state('deploying', 'building'); run('npm', ['run', 'build'], cwd);
  await state('deploying', 'restarting'); run('/usr/bin/systemctl', ['restart', 'remote-coder-backend.service'], cwd);
  await health(); await state('succeeded', 'healthy');
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'deployment_failed';
  if (deployment && previous && changed) {
    try {
      const cwd = deployment.sourcePath;
      run('git', ['checkout', '--detach', previous], cwd); run('npm', ['ci'], cwd); run('npm', ['run', 'build'], cwd);
      run('/usr/bin/systemctl', ['restart', 'remote-coder-backend.service'], cwd); await health(); await state('rolled_back', 'rollback_healthy', code); process.exit(1);
    } catch { try { await state('failed', 'rollback_failed', code); } catch {} }
  } else { try { await state('failed', 'preflight_failed', code); } catch {} }
  process.exit(1);
}
