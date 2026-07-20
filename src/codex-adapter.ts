import { spawn, type ChildProcess } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import type { AgentAdapter, AgentEventEmitter, Job, Repository } from './types.js';
import { buildJobPrompt, childEnvironment, collectChanges, parseScopeRequired, prepareRepositories, stopProcess } from './agent-runtime.js';

export interface CodexAdapterOptions {
  codexBin: string;
  runsRoot: string;
  workspaceRoot: string;
  timeoutMs: number;
  killGraceMs: number;
  log: FastifyBaseLogger;
}

export class CodexTimeoutError extends Error {
  constructor() { super('Codex execution timed out'); this.name = 'CodexTimeoutError'; }
}

export class CodexProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'CodexProtocolError'; }
}

export { buildJobPrompt } from './agent-runtime.js';

type TranslatedEvent = { type: string; message: string; data: unknown };

function diagnosticEvent(event: Record<string, unknown>): TranslatedEvent {
  const item = event.item as Record<string, unknown> | undefined;
  return {
    type: 'diagnostic',
    message: `Codex emitted unrecognized event type: ${String(event.type ?? 'unknown')}`,
    data: {
      eventType: String(event.type ?? 'unknown'),
      itemType: item?.type === undefined ? undefined : String(item.type),
      itemId: item?.id === undefined ? undefined : String(item.id),
      status: event.status === undefined ? undefined : String(event.status),
    },
  };
}

export function translateCodexEvent(event: Record<string, unknown>): TranslatedEvent {
  const type = String(event.type ?? '');
  const item = event.item as Record<string, unknown> | undefined;
  if (type === 'thread.started') return { type: 'session', message: 'Codex session started', data: { threadId: event.thread_id } };
  if (type === 'turn.completed') return { type: 'token_usage', message: 'Codex turn completed', data: event.usage ?? {} };
  if (type === 'turn.failed' || type === 'error') return { type: 'error', message: String((event.error as Record<string, unknown> | undefined)?.message ?? event.message ?? 'Codex reported an error'), data: event };
  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const itemType = String(item?.type ?? '');
    if (itemType === 'command_execution') return { type: 'command', message: String(item?.command ?? 'Command execution'), data: item };
    if (itemType === 'file_change') return { type: 'file_change', message: String(item?.path ?? item?.changes ?? 'Files changed'), data: item };
    if (itemType === 'agent_message') return { type: 'progress', message: String(item?.text ?? ''), data: item };
    if (itemType === 'reasoning') return { type: 'progress', message: String(item?.text ?? 'Codex is working'), data: item };
  }
  return diagnosticEvent(event);
}

export class CodexAgentAdapter implements AgentAdapter {
  constructor(private readonly options: CodexAdapterOptions) {}

  async run(job: Job, repositories: Repository[], emit: AgentEventEmitter, signal: AbortSignal): Promise<void> {
    const { runDirectory, prepared } = await prepareRepositories(job, repositories, this.options.workspaceRoot, this.options.runsRoot, emit);

    const prompt = buildJobPrompt(job, prepared, runDirectory);
    await this.executeCodex(job.id, prompt, runDirectory, emit, signal);
    for (const repository of prepared) {
      try { emit('repository_result', `Collected changes for ${repository.repository.name}`, { ...(await collectChanges(repository)), scopeReason: job.scopeReasons.find((reason) => reason.repositoryId === repository.repository.id)?.reason }); }
      catch (error) { emit('error', `Could not collect changes for ${repository.repository.name}`, { error: error instanceof Error ? error.message : String(error) }); }
    }
  }

  private executeCodex(jobId: string, prompt: string, runDirectory: string, emit: AgentEventEmitter, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['exec', '--json', '--ephemeral', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-c', 'approval_policy="never"', '--color', 'never', '-C', runDirectory, '-'];
      const child = spawn(this.options.codexBin, args, { cwd: runDirectory, env: childEnvironment('codex'), detached: process.platform === 'linux', stdio: ['pipe', 'pipe', 'pipe'] });
      let settled = false; let timedOut = false; let protocolCompleted = false; let protocolError: Error | undefined;
      let latestAgentMessage: { message: string; data: unknown } | undefined;
      this.options.log.info({ jobId, adapter: 'codex', childPid: child.pid }, 'agent child started');
      const finish = (error?: unknown) => { if (settled) return; settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => { this.options.log.info({ jobId, adapter: 'codex', childPid: child.pid, cancelled: true, timedOut: false, protocolCompleted }, 'agent child stopping'); stopProcess(child, this.options.killGraceMs); };
      const timeout = setTimeout(() => { timedOut = true; this.options.log.warn({ jobId, adapter: 'codex', childPid: child.pid, cancelled: false, timedOut: true, protocolCompleted }, 'agent child timed out'); stopProcess(child, this.options.killGraceMs); }, this.options.timeoutMs);
      timeout.unref();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.once('error', finish);
      child.stdin.on('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') finish(error); });
      child.stderr.resume();
      let stdoutBuffer = ''; let stdoutAll = ''; let parsedLines = 0;
      const parseLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const translated = translateCodexEvent(event);
          const item = event.item as Record<string, unknown> | undefined;
          if ((event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') && item?.type === 'agent_message') {
            latestAgentMessage = { message: translated.message, data: translated.data };
          }
          emit(translated.type, translated.message, translated.data);
          if (event.type === 'turn.completed') {
            protocolCompleted = true;
            if (latestAgentMessage) {
              const required = parseScopeRequired(latestAgentMessage.message);
              if (required) emit('scope_required', 'Additional repository scope is required', required);
              else emit('final_response', latestAgentMessage.message, latestAgentMessage.data);
            }
          } else if (event.type === 'turn.failed' || event.type === 'error') {
            protocolError = new CodexProtocolError(translated.message);
          }
        } catch { emit('diagnostic', 'Received invalid JSONL from Codex', { reason: 'invalid_jsonl' }); }
      };
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdoutBuffer += chunk; stdoutAll += chunk;
        const lines = stdoutBuffer.split('\n'); stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) { parsedLines++; parseLine(line); }
      });
      child.once('close', (code, processSignal) => {
        if (parsedLines === 0 && stdoutAll) for (const line of stdoutAll.split('\n')) parseLine(line);
        else parseLine(stdoutBuffer);
        this.options.log.info({ jobId, adapter: 'codex', childPid: child.pid, exitCode: code, signal: processSignal, timedOut, cancelled: signal.aborted, protocolCompleted }, 'agent child exited');
        if (timedOut) return finish(new CodexTimeoutError());
        if (signal.aborted) return finish(signal.reason ?? new Error('cancelled'));
        if (code !== 0) return finish(new Error(`Codex exited with code ${code}${processSignal ? ` (${processSignal})` : ''}`));
        if (protocolError) return finish(protocolError);
        if (!protocolCompleted) return finish(new CodexProtocolError('protocol_incomplete: Codex exited without turn.completed'));
        finish();
      });
      child.stdin.end(prompt);
    });
  }

}
