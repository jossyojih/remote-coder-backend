import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentEventEmitter, Job, Repository } from './types.js';

export type PreparedRepository = { repository: Repository; sourcePath: string; worktreePath: string; branch: string; remoteName: string; remoteUrl: string; targetBranch: string; baseCommitSha: string; gitCommonDir: string };

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
}

export function childEnvironment(provider?: 'codex' | 'claude'): NodeJS.ProcessEnv {
  const common = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  const providerKeys = provider === 'codex' ? ['CODEX_HOME'] : provider === 'claude' ? ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID'] : [];
  const allowed = [...common, ...providerKeys];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}

export function runCommand(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args[0] ?? ''} failed (${code}): ${stderr.trim()}`)));
  });
}

export function stopProcess(child: ChildProcess, graceMs: number): void {
  if (!child.pid || child.exitCode !== null) return;
  const signal = (name: NodeJS.Signals) => {
    try { if (process.platform === 'linux') process.kill(-child.pid!, name); else child.kill(name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  signal('SIGTERM');
  const timer = setTimeout(() => { if (child.exitCode === null) signal('SIGKILL'); }, graceMs);
  timer.unref(); child.once('close', () => clearTimeout(timer));
}

export function buildJobPrompt(job: Job, repositories: PreparedRepository[], runDirectory: string): string {
  const listing = repositories.map(({ repository, worktreePath }) => `- ${repository.name}: ${worktreePath}`).join('\n');
  const prior = job.conversationContext ? `\n\nPrior conversation context (bounded, oldest to newest):\n${job.conversationContext}` : '';
  return `You are executing backend job ${job.id} in an isolated run directory.\n\nSelected repositories (all and only the repositories you may access):\n${listing}${prior}\n\nCurrent user request:\n${job.prompt}\n\nRules:\n- Do not read, write, or traverse outside ${runDirectory}.\n- Work only in the selected repository directories listed above.\n- Do not create or use subagents.\n- Run relevant tests and builds for the changes you make.\n- Do not commit, push, deploy, or delete worktrees.\n- Finish with a concise summary of changes and validation results.\n`;
}

export async function prepareRepositories(job: Job, repositories: Repository[], workspaceRoot: string, runsRootOption: string, emit: AgentEventEmitter): Promise<{ runDirectory: string; prepared: PreparedRepository[] }> {
  const root = await realpath(workspaceRoot);
  const configuredRunsRoot = isAbsolute(runsRootOption) ? runsRootOption : join(process.cwd(), runsRootOption);
  await mkdir(configuredRunsRoot, { recursive: true });
  const runsRoot = await realpath(configuredRunsRoot);
  const requestedRunDirectory = join(runsRoot, job.id);
  await mkdir(requestedRunDirectory, { recursive: true });
  const runDirectory = await realpath(requestedRunDirectory);
  const runRel = relative(runsRoot, runDirectory);
  if (runRel.startsWith('..') || isAbsolute(runRel)) throw new Error('Job run directory escapes RUNS_ROOT');
  const branch = `remote-engineer/${job.id}`;
  const prepared: PreparedRepository[] = [];
  for (const [index, repository] of repositories.entries()) {
    const sourcePath = await realpath(repository.path);
    const rel = relative(root, sourcePath);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Repository ${repository.name} is outside WORKSPACE_ROOT`);
    await runCommand('git', ['-C', sourcePath, 'rev-parse', '--is-inside-work-tree']);
    const remoteName = repository.remoteName ?? 'origin';
    const remoteUrl = (await runCommand('git', ['-C', sourcePath, 'remote', 'get-url', remoteName])).stdout.trim();
    const configuredBranch = (await runCommand('git', ['-C', sourcePath, 'symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
    if (!/^(?!-)(?!.*\.\.)(?!.*[~^:?*\\[\\]\\\\\s])[^/]+(?:\/[^/]+)*$/.test(configuredBranch)) throw new Error(`Repository ${repository.name} has an unsafe target branch`);
    const targetBranch = repository.targetBranch ?? configuredBranch;
    if (!/^(?!-)(?!.*\.\.)(?!.*[~^:?*\\[\\]\\\\\s])[^/]+(?:\/[^/]+)*$/.test(targetBranch)) throw new Error(`Repository ${repository.name} has an unsafe target branch`);
    await runCommand('git', ['-C', sourcePath, 'fetch', '--no-tags', remoteName, `+refs/heads/${targetBranch}:refs/remotes/${remoteName}/${targetBranch}`]);
    const baseCommitSha = (await runCommand('git', ['-C', sourcePath, 'rev-parse', '--verify', `${remoteName}/${targetBranch}^{commit}`])).stdout.trim();
    const gitCommonDir = await realpath(resolve(sourcePath, (await runCommand('git', ['-C', sourcePath, 'rev-parse', '--git-common-dir'])).stdout.trim()));
    const worktreePath = join(runDirectory, `${index + 1}-${safeName(repository.name)}-${repository.id.slice(0, 8)}`);
    await runCommand('git', ['-C', sourcePath, 'worktree', 'add', '-b', branch, worktreePath, baseCommitSha]);
    prepared.push({ repository, sourcePath, worktreePath, branch, remoteName, remoteUrl, targetBranch, baseCommitSha, gitCommonDir });
    emit('worktree', `Prepared worktree for ${repository.name}`, { repositoryId: repository.id, worktreePath, sourcePath, branch, remoteName, remoteUrl, targetBranch, baseCommitSha, gitCommonDir });
  }
  return { runDirectory, prepared };
}

export async function collectChanges(prepared: PreparedRepository) {
  const [status, files, stats] = await Promise.all([
    runCommand('git', ['status', '--porcelain=v1'], prepared.worktreePath),
    runCommand('git', ['diff', '--name-only', 'HEAD'], prepared.worktreePath),
    runCommand('git', ['diff', '--stat', 'HEAD'], prepared.worktreePath),
  ]);
  const changedFiles = new Set(files.stdout.trim() ? files.stdout.trim().split('\n') : []);
  for (const line of status.stdout.trimEnd().split('\n')) if (line) changedFiles.add(line.slice(3).replace(/^.* -> /, ''));
  return { repositoryId: prepared.repository.id, repositoryName: prepared.repository.name, directory: prepared.worktreePath, branch: prepared.branch, status: status.stdout.trim(), changedFiles: [...changedFiles], diffStat: stats.stdout.trim() };
}
