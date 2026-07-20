import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { translateClaudeEvent } from '../src/claude-adapter.js';

const apps: FastifyInstance[] = [];
const auth = { authorization: 'Bearer test-token' };
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}

function repository(root: string, name: string) {
  const path = join(root, name); mkdirSync(path); git(path, ['init', '-q']);
  writeFileSync(join(path, 'README.md'), `${name}\n`); git(path, ['add', 'README.md']);
  git(path, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
  return path;
}

function fakeClaude(root: string) {
  const path = join(root, 'fake-claude.mjs'); const capture = join(root, 'capture.json');
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
const output = (value) => writeSync(1, JSON.stringify(value) + '\\n');
const prompt = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), prompt, env: process.env }));
if (prompt.includes('STARTUP_MCP_ERROR')) { writeSync(2, 'Error: Invalid MCP configuration:\\nmcpServers: Invalid input: expected record, received undefined\\nPROMPT=' + prompt + '\\nANTHROPIC_API_KEY=secret-token\\n'); process.exit(1); }
if (prompt.includes('STARTUP_UNKNOWN_ERROR')) { writeSync(2, 'Error: private failure; prompt=' + prompt + '; token=secret-token\\n'); process.exit(1); }
if (prompt.includes('API_CREDENTIAL_ERROR')) { writeSync(2, 'stderr prompt=' + prompt + ' token=secret-token\\n'); output({type:'result',subtype:'success',is_error:true,result:'API Error: Could not load credentials from any providers',terminal_reason:'api_error'}); process.exit(1); }
output({type:'system',subtype:'init',session_id:'session-test',model:'sonnet'});
output({type:'assistant',message:{id:'message-1',content:[{type:'text',text:'Inspecting files'},{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'npm test'}},{type:'tool_use',id:'tool-2',name:'Edit',input:{file_path:'README.md',old_string:'x',new_string:'y'}}],usage:{input_tokens:10,output_tokens:3}}});
if (prompt.includes('MALFORMED')) writeSync(1, '{bad json\\n');
if (prompt.includes('CHANGE_FILES')) for (const line of prompt.split('\\n')) if (/^- .*: \\/.*/.test(line)) appendFileSync(line.replace(/^- .*: /, '') + '/README.md', 'changed\\n');
if (prompt.includes('WAIT_FOREVER')) await new Promise((resolve) => setInterval(resolve, 60_000));
if (prompt.includes('EXIT_NONZERO')) process.exit(9);
if (prompt.includes('INCOMPLETE')) process.exit(0);
if (prompt.includes('ERROR_RESULT')) { output({type:'result',subtype:'error_during_execution',is_error:true,result:'Claude failed safely'}); process.exit(0); }
output({type:'result',subtype:'success',is_error:false,result:'Fake Claude final response',session_id:'session-test',usage:{input_tokens:12,output_tokens:5}});
`);
  chmodSync(path, 0o755); return path;
}

async function fixture(options: { timeout?: number; grace?: number; model?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-adapter-')); const repoA = repository(root, 'repo-a'); const repoB = repository(root, 'repo-b');
  const built = await buildApp({ databasePath: join(root, 'test.sqlite'), workspaceRoot: root, apiToken: 'test-token', claudeBin: fakeClaude(root), claudeModel: options.model, runsRoot: join(root, 'runs'), jobTimeoutMs: options.timeout ?? 5_000, jobKillGraceMs: options.grace ?? 20 });
  apps.push(built.app);
  const response = await built.app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'Test', repositories: [{ name: 'A', path: repoA }, { name: 'B', path: repoB }] } });
  assert.equal(response.statusCode, 201);
  return { ...built, root, capture: join(root, 'capture.json'), project: response.json(), repoA, repoB };
}

async function createJob(app: FastifyInstance, project: any, prompt: string, count = 1) {
  const response = await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId: project.id, prompt, agent: 'claude', selectedRepositoryIds: project.repositories.slice(0, count).map((repo: any) => repo.id) } });
  assert.equal(response.statusCode, 201); return response.json();
}

async function terminal(store: any, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) { const job = store.getJob(id); if (['done', 'failed', 'cancelled'].includes(job.status)) return job; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail('job did not reach a terminal state');
}

test('Claude runs non-interactively with safe permissions and translates its stream', async () => {
  const { app, store, project, capture, root } = await fixture({ model: 'test-sonnet' }); const job = await createJob(app, project, 'Do work');
  assert.equal((await terminal(store, job.id)).status, 'done'); const events = store.events(job.id);
  assert.equal(events.find((event: any) => event.type === 'session')?.data.sessionId, 'session-test');
  assert.ok(events.some((event: any) => event.type === 'progress' && event.message === 'Inspecting files'));
  assert.equal(events.find((event: any) => event.type === 'command')?.message, 'npm test');
  assert.equal(events.find((event: any) => event.type === 'file_change')?.message, 'README.md');
  assert.equal(events.find((event: any) => event.type === 'final_response')?.message, 'Fake Claude final response');
  assert.deepEqual(events.filter((event: any) => event.type === 'token_usage').at(-1)?.data, { input_tokens: 12, output_tokens: 5 });
  const captured = JSON.parse(readFileSync(capture, 'utf8')); assert.ok(captured.args.includes('--print')); assert.ok(captured.args.includes('stream-json'));
  assert.equal(captured.args[captured.args.indexOf('--permission-mode') + 1], 'dontAsk'); assert.ok(!captured.args.includes('--dangerously-skip-permissions'));
  assert.equal(captured.args[captured.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(captured.args[captured.args.indexOf('--model') + 1], 'test-sonnet'); assert.ok(captured.prompt.includes(join(root, 'runs', job.id)));
  assert.ok(!('OPENAI_API_KEY' in captured.env));
});

test('Claude reuses isolated multi-repository worktrees and collects changes', async () => {
  const { app, store, project, root, repoA, repoB } = await fixture(); const job = await createJob(app, project, 'CHANGE_FILES', 2);
  assert.equal((await terminal(store, job.id)).status, 'done'); const results = store.events(job.id).filter((event: any) => event.type === 'repository_result');
  assert.equal(results.length, 2); for (const result of results) { assert.deepEqual(result.data.changedFiles, ['README.md']); assert.ok(result.data.directory.startsWith(join(root, 'runs', job.id))); }
  assert.equal(readFileSync(join(repoA, 'README.md'), 'utf8'), 'repo-a\n'); assert.equal(readFileSync(join(repoB, 'README.md'), 'utf8'), 'repo-b\n');
});

test('malformed Claude output fails and never produces repository results', async () => {
  const { app, store, project } = await fixture(); const job = await createJob(app, project, 'MALFORMED'); assert.equal((await terminal(store, job.id)).status, 'failed');
  const events = store.events(job.id); assert.match((events.at(-1)?.data as any).error, /malformed_output/); assert.equal(events.some((event: any) => event.type === 'repository_result'), false);
});

test('zero exit with incomplete Claude protocol fails', async () => {
  const { app, store, project } = await fixture(); const job = await createJob(app, project, 'INCOMPLETE'); assert.equal((await terminal(store, job.id)).status, 'failed');
  assert.match((store.events(job.id).at(-1)?.data as any).error, /protocol_incomplete/);
});

test('Claude error result and nonzero exit both fail', async (context) => {
  await context.test('error result', async () => { const { app, store, project } = await fixture(); const job = await createJob(app, project, 'ERROR_RESULT'); assert.equal((await terminal(store, job.id)).status, 'failed'); assert.ok(store.events(job.id).some((event: any) => event.type === 'error' && event.message === 'Claude reported error_during_execution')); assert.ok(store.events(job.id).every((event: any) => !event.message.includes('Claude failed safely'))); });
  await context.test('nonzero exit', async () => { const { app, store, project } = await fixture(); const job = await createJob(app, project, 'EXIT_NONZERO'); assert.equal((await terminal(store, job.id)).status, 'failed'); assert.match((store.events(job.id).at(-1)?.data as any).error, /code 9/); });
});

test('Claude startup failures persist only allowlisted sanitized stderr diagnostics', async (context) => {
  await context.test('known CLI configuration error', async () => {
    const { app, store, project } = await fixture(); const job = await createJob(app, project, 'STARTUP_MCP_ERROR private-prompt-value');
    assert.equal((await terminal(store, job.id)).status, 'failed');
    const failure = (store.events(job.id).at(-1)?.data as any).error as string;
    assert.match(failure, /code 1: invalid MCP configuration \(mcpServers must be an object\)$/);
    assert.doesNotMatch(failure, /private-prompt-value|secret-token|ANTHROPIC_API_KEY/);
  });
  await context.test('unknown stderr is withheld', async () => {
    const { app, store, project } = await fixture(); const job = await createJob(app, project, 'STARTUP_UNKNOWN_ERROR private-prompt-value');
    assert.equal((await terminal(store, job.id)).status, 'failed');
    const failure = (store.events(job.id).at(-1)?.data as any).error as string;
    assert.equal(failure, 'Claude exited with code 1');
    assert.doesNotMatch(failure, /private-prompt-value|secret-token/);
  });
  await context.test('structured API credential error takes precedence over exit code', async () => {
    const { app, store, project } = await fixture(); const job = await createJob(app, project, 'API_CREDENTIAL_ERROR private-prompt-value');
    assert.equal((await terminal(store, job.id)).status, 'failed');
    const events = store.events(job.id); const failure = (events.at(-1)?.data as any).error as string;
    assert.equal(failure, 'Claude API error: credentials unavailable');
    assert.ok(events.some((event: any) => event.type === 'error' && event.message === 'Claude API error: credentials unavailable'));
    assert.ok(events.every((event: any) => !event.message.includes('private-prompt-value') && !event.message.includes('secret-token')));
  });
});

test('Claude timeout and cancellation terminate the child without reporting done', async (context) => {
  await context.test('timeout', async () => { const { app, store, project } = await fixture({ timeout: 50 }); const job = await createJob(app, project, 'WAIT_FOREVER'); assert.equal((await terminal(store, job.id)).status, 'failed'); assert.match((store.events(job.id).at(-1)?.data as any).error, /timed out/); });
  await context.test('cancellation', async () => { const { app, store, project } = await fixture(); const job = await createJob(app, project, 'WAIT_FOREVER'); while (store.getJob(job.id)?.status !== 'running') await new Promise((resolve) => setTimeout(resolve, 5)); const response = await app.inject({ method: 'POST', url: `/jobs/${job.id}/cancel`, headers: auth }); assert.equal(response.statusCode, 200); assert.equal((await terminal(store, job.id)).status, 'cancelled'); });
});

test('Claude translation diagnostics do not retain unknown event payloads', () => {
  const translated = translateClaudeEvent({ type: 'future', subtype: 'new', secret: 'do-not-store' }); assert.equal(translated[0]?.type, 'diagnostic'); assert.deepEqual(translated[0]?.data, { eventType: 'future', subtype: 'new' });
});
