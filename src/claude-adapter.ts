import { spawn } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import { buildJobPrompt, childEnvironment, collectChanges, prepareRepositories, stopProcess } from './agent-runtime.js';
import type { AgentAdapter, AgentEventEmitter, Job, Repository } from './types.js';

export interface ClaudeAdapterOptions {
  claudeBin: string;
  model: string;
  runsRoot: string;
  workspaceRoot: string;
  timeoutMs: number;
  killGraceMs: number;
  log: FastifyBaseLogger;
}

export class ClaudeTimeoutError extends Error {
  constructor() { super('Claude execution timed out'); this.name = 'ClaudeTimeoutError'; }
}

export class ClaudeProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'ClaudeProtocolError'; }
}

type TranslatedEvent = { type: string; message: string; data: unknown };

const STDERR_CAPTURE_LIMIT = 8_192;

function sanitizedStartupDiagnostic(stderr: string): string | undefined {
  const plain = stderr.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, ' ');
  if (/invalid mcp configuration/i.test(plain)) {
    return /mcpServers[^\n]*expected record/i.test(plain)
      ? 'invalid MCP configuration (mcpServers must be an object)'
      : 'invalid MCP configuration';
  }
  const unknownOption = plain.match(/unknown option(?:\s*[:'])?\s*['"]?(--[a-zA-Z0-9-]+)/i);
  if (unknownOption) return `unsupported CLI option ${unknownOption[1]}`;
  if (/not logged in|authentication required|please (?:run|use) .*login/i.test(plain)) return 'Claude authentication is required';
  if (/permission mode[^\n]*(?:invalid|unknown)|invalid[^\n]*permission mode/i.test(plain)) return 'invalid Claude permission mode';
  return undefined;
}

function sanitizedResultError(event: Record<string, unknown>): string {
  const result = typeof event.result === 'string' ? event.result : '';
  if (/could not load credentials from any providers/i.test(result)) return 'Claude API error: credentials unavailable';
  if (/not logged in|authentication required|please (?:run|use) .*login/i.test(result)) return 'Claude authentication is required';
  if (/rate limit|too many requests/i.test(result)) return 'Claude API error: rate limited';
  if (/model[^\n]*(?:not found|not available|unsupported|invalid)/i.test(result)) return 'Claude API error: configured model is unavailable';
  return `Claude reported ${String(event.subtype ?? event.terminal_reason ?? 'an execution error')}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textBlocks(message: Record<string, unknown> | undefined): string[] {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.flatMap((block) => {
    const item = record(block);
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  });
}

function toolEvents(message: Record<string, unknown> | undefined): TranslatedEvent[] {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.flatMap((block) => {
    const item = record(block); if (item?.type !== 'tool_use') return [];
    const name = String(item.name ?? 'tool'); const input = record(item.input);
    if (name === 'Bash') return [{ type: 'command', message: typeof input?.command === 'string' ? input.command : 'Claude command', data: { toolUseId: item.id, tool: name, command: input?.command } }];
    if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
      const path = input?.file_path ?? input?.notebook_path;
      return [{ type: 'file_change', message: typeof path === 'string' ? path : 'Claude changed a file', data: { toolUseId: item.id, tool: name, path } }];
    }
    return [{ type: 'progress', message: `Claude is using ${name}`, data: { toolUseId: item.id, tool: name } }];
  });
}

export function translateClaudeEvent(event: Record<string, unknown>): TranslatedEvent[] {
  const type = String(event.type ?? '');
  if (type === 'system' && event.subtype === 'init') return [{ type: 'session', message: 'Claude session started', data: { sessionId: event.session_id, model: event.model } }];
  if (type === 'assistant') {
    const message = record(event.message); const translated = toolEvents(message);
    for (const text of textBlocks(message)) translated.push({ type: 'progress', message: text, data: { messageId: message?.id } });
    const usage = record(message?.usage);
    if (usage) translated.push({ type: 'token_usage', message: 'Claude usage update', data: usage });
    return translated;
  }
  if (type === 'result') {
    const usage = record(event.usage); const translated: TranslatedEvent[] = [];
    if (usage) translated.push({ type: 'token_usage', message: 'Claude run completed', data: usage });
    if (event.is_error === true || event.subtype !== 'success') translated.push({ type: 'error', message: sanitizedResultError(event), data: { subtype: event.subtype, terminalReason: event.terminal_reason } });
    else if (typeof event.result === 'string') translated.push({ type: 'final_response', message: event.result, data: { sessionId: event.session_id } });
    return translated;
  }
  if (type === 'user') return [];
  return [{ type: 'diagnostic', message: `Claude emitted unrecognized event type: ${type || 'unknown'}`, data: { eventType: type || 'unknown', subtype: event.subtype === undefined ? undefined : String(event.subtype) } }];
}

export class ClaudeAgentAdapter implements AgentAdapter {
  constructor(private readonly options: ClaudeAdapterOptions) {}

  async run(job: Job, repositories: Repository[], emit: AgentEventEmitter, signal: AbortSignal): Promise<void> {
    const { runDirectory, prepared } = await prepareRepositories(job, repositories, this.options.workspaceRoot, this.options.runsRoot, emit);
    await this.executeClaude(job.id, buildJobPrompt(job, prepared, runDirectory), runDirectory, emit, signal);
    for (const repository of prepared) {
      try { emit('repository_result', `Collected changes for ${repository.repository.name}`, await collectChanges(repository)); }
      catch (error) { emit('error', `Could not collect changes for ${repository.repository.name}`, { error: error instanceof Error ? error.message : String(error) }); }
    }
  }

  private executeClaude(jobId: string, prompt: string, runDirectory: string, emit: AgentEventEmitter, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['--print', '--output-format', 'stream-json', '--verbose', '--model', this.options.model, '--permission-mode', 'dontAsk', '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep', '--no-session-persistence', '--disable-slash-commands', '--no-chrome', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
      const child = spawn(this.options.claudeBin, args, { cwd: runDirectory, env: childEnvironment('claude'), detached: process.platform === 'linux', stdio: ['pipe', 'pipe', 'pipe'] });
      let settled = false; let timedOut = false; let protocolCompleted = false; let protocolError: Error | undefined; let finalResponse: TranslatedEvent | undefined;
      this.options.log.info({ jobId, adapter: 'claude', childPid: child.pid }, 'agent child started');
      const finish = (error?: unknown) => { if (settled) return; settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => { this.options.log.info({ jobId, adapter: 'claude', childPid: child.pid, cancelled: true, timedOut: false, protocolCompleted }, 'agent child stopping'); stopProcess(child, this.options.killGraceMs); };
      const timeout = setTimeout(() => { timedOut = true; this.options.log.warn({ jobId, adapter: 'claude', childPid: child.pid, cancelled: false, timedOut: true, protocolCompleted }, 'agent child timed out'); stopProcess(child, this.options.killGraceMs); }, this.options.timeoutMs);
      timeout.unref(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      child.once('error', finish);
      child.stdin.on('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') finish(error); });
      let stderrBuffer = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        if (stderrBuffer.length < STDERR_CAPTURE_LIMIT) stderrBuffer += chunk.slice(0, STDERR_CAPTURE_LIMIT - stderrBuffer.length);
      });
      let stdoutBuffer = '';
      const parseLine = (line: string) => {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; }
        catch { protocolError ??= new ClaudeProtocolError('malformed_output: Claude emitted invalid stream JSON'); emit('error', 'Received invalid stream JSON from Claude', { reason: 'invalid_jsonl' }); return; }
        for (const translated of translateClaudeEvent(event)) {
          if (translated.type === 'final_response') finalResponse = translated;
          else emit(translated.type, translated.message, translated.data);
        }
        if (event.type === 'result') {
          if (event.subtype === 'success' && event.is_error !== true && typeof event.result === 'string') protocolCompleted = true;
          else protocolError ??= new ClaudeProtocolError(sanitizedResultError(event));
        }
      };
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdoutBuffer += chunk; const lines = stdoutBuffer.split('\n'); stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) parseLine(line);
      });
      child.once('close', (code, processSignal) => {
        parseLine(stdoutBuffer);
        this.options.log.info({ jobId, adapter: 'claude', childPid: child.pid, exitCode: code, signal: processSignal, timedOut, cancelled: signal.aborted, protocolCompleted }, 'agent child exited');
        if (timedOut) return finish(new ClaudeTimeoutError());
        if (signal.aborted) return finish(signal.reason ?? new Error('cancelled'));
        if (protocolError) return finish(protocolError);
        if (code !== 0) {
          const diagnostic = sanitizedStartupDiagnostic(stderrBuffer);
          const suffix = diagnostic ? `: ${diagnostic}` : '';
          return finish(new Error(`Claude exited with code ${code}${processSignal ? ` (${processSignal})` : ''}${suffix}`));
        }
        if (!protocolCompleted) return finish(new ClaudeProtocolError('protocol_incomplete: Claude exited without a successful result'));
        if (!finalResponse) return finish(new ClaudeProtocolError('protocol_incomplete: Claude success result had no final response'));
        emit(finalResponse.type, finalResponse.message, finalResponse.data);
        finish();
      });
      child.stdin.end(prompt);
    });
  }
}
