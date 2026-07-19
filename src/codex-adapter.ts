import { mkdir, realpath } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, join, relative } from 'node:path';
import type { AgentAdapter, AgentEventEmitter, Job, Repository } from './types.js';

export interface CodexAdapterOptions {
  codexBin: string;
  runsRoot: string;
  workspaceRoot: string;
  timeoutMs: number;
  killGraceMs: number;
}

type PreparedRepository = { repository: Repository; sourcePath: string; worktreePath: string; branch: string };

export class CodexTimeoutError extends Error {
  constructor() { super('Codex execution timed out'); this.name = 'CodexTimeoutError'; }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
}

function childEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'CODEX_HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}

function runCommand(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args[0] ?? ''} failed (${code}): ${stderr.trim()}`)));
  });
}

function stopProcess(child: ChildProcess, graceMs: number): void {
  if (!child.pid || child.exitCode !== null) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (process.platform === 'linux') process.kill(-child.pid!, name);
      else child.kill(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  signal('SIGTERM');
  const timer = setTimeout(() => { if (child.exitCode === null) signal('SIGKILL'); }, graceMs);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

export function buildJobPrompt(job: Job, repositories: PreparedRepository[], runDirectory: string): string {
  const listing = repositories.map(({ repository, worktreePath }) => `- ${repository.name}: ${worktreePath}`).join('\n');
  return `You are executing backend job ${job.id} in an isolated run directory.\n\nSelected repositories (all and only the repositories you may access):\n${listing}\n\nRequested outcome:\n${job.prompt}\n\nRules:\n- Do not read, write, or traverse outside ${runDirectory}.\n- Work only in the selected repository directories listed above.\n- Do not create or use subagents.\n- Run relevant tests and builds for the changes you make.\n- Do not commit, push, deploy, or delete worktrees.\n- Finish with a concise summary of changes and validation results.\n`;
}

export function translateCodexEvent(event: Record<string, unknown>): { type: string; message: string; data: unknown } | undefined {
  const type = String(event.type ?? '');
  const item = event.item as Record<string, unknown> | undefined;
  if (type === 'thread.started') return { type: 'session', message: 'Codex session started', data: { threadId: event.thread_id } };
  if (type === 'turn.completed') return { type: 'usage', message: 'Codex turn completed', data: event.usage ?? {} };
  if (type === 'turn.failed' || type === 'error') return { type: 'error', message: String((event.error as Record<string, unknown> | undefined)?.message ?? event.message ?? 'Codex reported an error'), data: event };
  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const itemType = String(item?.type ?? '');
    if (itemType === 'command_execution') return { type: 'command', message: String(item?.command ?? 'Command execution'), data: item };
    if (itemType === 'file_change') return { type: 'file_change', message: String(item?.path ?? item?.changes ?? 'Files changed'), data: item };
    if (itemType === 'agent_message') return { type: type === 'item.completed' ? 'final_response' : 'progress', message: String(item?.text ?? ''), data: item };
    if (itemType === 'reasoning') return { type: 'progress', message: String(item?.text ?? 'Codex is working'), data: item };
  }
  return undefined;
}

export class CodexAgentAdapter implements AgentAdapter {
  constructor(private readonly options: CodexAdapterOptions) {}

  async run(job: Job, repositories: Repository[], emit: AgentEventEmitter, signal: AbortSignal): Promise<void> {
    const root = await realpath(this.options.workspaceRoot);
    const configuredRunsRoot = isAbsolute(this.options.runsRoot) ? this.options.runsRoot : join(process.cwd(), this.options.runsRoot);
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
      const worktreePath = join(runDirectory, `${index + 1}-${safeName(repository.name)}-${repository.id.slice(0, 8)}`);
      await runCommand('git', ['-C', sourcePath, 'worktree', 'add', '-b', branch, worktreePath]);
      prepared.push({ repository, sourcePath, worktreePath, branch });
      emit('worktree', `Prepared worktree for ${repository.name}`, { repositoryId: repository.id, directory: worktreePath, branch });
    }

    const prompt = buildJobPrompt(job, prepared, runDirectory);
    let executionError: unknown;
    try {
      await this.executeCodex(prompt, runDirectory, emit, signal);
    } catch (error) { executionError = error; }
    for (const repository of prepared) {
      try { emit('repository_result', `Collected changes for ${repository.repository.name}`, await this.collectChanges(repository)); }
      catch (error) { emit('error', `Could not collect changes for ${repository.repository.name}`, { error: error instanceof Error ? error.message : String(error) }); }
    }
    if (executionError) throw executionError;
  }

  private executeCodex(prompt: string, runDirectory: string, emit: AgentEventEmitter, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['exec', '--json', '--ephemeral', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-c', 'approval_policy="never"', '--color', 'never', '-C', runDirectory, '-'];
      const child = spawn(this.options.codexBin, args, { cwd: runDirectory, env: childEnvironment(), detached: process.platform === 'linux', stdio: ['pipe', 'pipe', 'pipe'] });
      let settled = false; let timedOut = false;
      const finish = (error?: unknown) => { if (settled) return; settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => { stopProcess(child, this.options.killGraceMs); };
      const timeout = setTimeout(() => { timedOut = true; stopProcess(child, this.options.killGraceMs); }, this.options.timeoutMs);
      timeout.unref();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.once('error', finish);
      child.stdin.on('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') finish(error); });
      child.stderr.resume();
      let stdoutBuffer = ''; let stdoutAll = ''; let parsedLines = 0;
      const parseLine = (line: string) => {
        if (!line.trim()) return;
        try { const translated = translateCodexEvent(JSON.parse(line) as Record<string, unknown>); if (translated) emit(translated.type, translated.message, translated.data); }
        catch { emit('error', 'Received invalid JSONL from Codex', { line }); }
      };
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdoutBuffer += chunk; stdoutAll += chunk;
        const lines = stdoutBuffer.split('\n'); stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) { parsedLines++; parseLine(line); }
      });
      child.once('close', (code, processSignal) => {
        if (parsedLines === 0 && stdoutAll) for (const line of stdoutAll.split('\n')) parseLine(line);
        else parseLine(stdoutBuffer);
        if (timedOut) return finish(new CodexTimeoutError());
        if (signal.aborted) return finish(signal.reason ?? new Error('cancelled'));
        if (code !== 0) return finish(new Error(`Codex exited with code ${code}${processSignal ? ` (${processSignal})` : ''}`));
        finish();
      });
      child.stdin.end(prompt);
    });
  }

  private async collectChanges(prepared: PreparedRepository) {
    const [status, files, stats] = await Promise.all([
      runCommand('git', ['status', '--porcelain=v1'], prepared.worktreePath),
      runCommand('git', ['diff', '--name-only', 'HEAD'], prepared.worktreePath),
      runCommand('git', ['diff', '--stat', 'HEAD'], prepared.worktreePath),
    ]);
    const changedFiles = new Set(files.stdout.trim() ? files.stdout.trim().split('\n') : []);
    for (const line of status.stdout.trimEnd().split('\n')) if (line) changedFiles.add(line.slice(3).replace(/^.* -> /, ''));
    return { repositoryId: prepared.repository.id, repositoryName: prepared.repository.name, directory: prepared.worktreePath, branch: prepared.branch, status: status.stdout.trim(), changedFiles: [...changedFiles], diffStat: stats.stdout.trim() };
  }
}
