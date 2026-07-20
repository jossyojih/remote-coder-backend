import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { translateCodexEvent } from '../src/codex-adapter.js';

const apps: FastifyInstance[] = [];
const auth = { authorization: 'Bearer test-token' };
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}

function repository(root: string, name: string) {
  const path = join(root, name); mkdirSync(path);
  git(path, ['init', '-q']); writeFileSync(join(path, 'README.md'), `${name}\n`);
  git(path, ['add', 'README.md']);
  git(path, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
  const remote = join(root, `${name}.git`); mkdirSync(remote); git(remote, ['init', '--bare', '-q']);
  git(path, ['branch', '-M', 'main']); git(path, ['remote', 'add', 'origin', remote]); git(path, ['push', '-u', 'origin', 'main']);
  return path;
}

function fakeCodex(root: string) {
  const path = join(root, 'fake-codex.mjs');
  const capture = join(root, 'capture.json');
  writeFileSync(path, `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { writeSync } from 'node:fs';
const output = (value) => writeSync(1, JSON.stringify(value) + '\\n');
const prompt = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), prompt, env: process.env }));
output({type:'thread.started', thread_id:'thread-test'});
output({type:'item.completed',item:{type:'agent_message',text:'Fake intermediate response'}});
output({type:'item.completed',item:{type:'command_execution',command:'fake command',exit_code:2,status:'failed'}});
if (prompt.includes('INVALID_JSON')) writeSync(1, '{bad json\\n');
if (prompt.includes('CHANGE_FILES')) for (const line of prompt.split('\\n')) if (/^- .*: \\/.*/.test(line)) appendFileSync(line.replace(/^- .*: /, '') + '/README.md', 'changed\\n');
if (prompt.includes('WAIT_FOREVER')) await new Promise((resolve) => setInterval(resolve, 60_000));
if (prompt.includes('EXIT_NONZERO')) process.exit(7);
if (prompt.includes('EXIT_ZERO_INCOMPLETE')) process.exit(0);
if (prompt.includes('TURN_FAILED')) { output({type:'turn.failed',error:{message:'model turn failed'}}); process.exit(0); }
if (prompt.includes('ERROR_EVENT')) { output({type:'error',message:'stream protocol error'}); process.exit(0); }
output({type:'item.completed',item:{type:'file_change',path:'README.md'}});
output({type:'item.completed',item:{type:'agent_message',text:'Fake final response'}});
output({type:'turn.completed',usage:{input_tokens:12,output_tokens:4}});
`);
  chmodSync(path, 0o755); return path;
}

async function fixture(options: { timeout?: number; grace?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-adapter-'));
  const repoA = repository(root, 'repo-a'); const repoB = repository(root, 'repo-b');
  const capture = join(root, 'capture.json');
  const built = await buildApp({ databasePath: join(root, 'test.sqlite'), workspaceRoot: root, apiToken: 'test-token', codexBin: fakeCodex(root), runsRoot: join(root, 'runs'), jobTimeoutMs: options.timeout ?? 5_000, jobKillGraceMs: options.grace ?? 20 });
  apps.push(built.app);
  const response = await built.app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'Test', repositories: [{ name: 'A', path: repoA }, { name: 'B', path: repoB }] } });
  assert.equal(response.statusCode, 201);
  return { ...built, root, capture, project: response.json(), repoA, repoB };
}

async function createJob(app: FastifyInstance, project: any, prompt: string, count = 1) {
  const response = await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId: project.id, prompt, agent: 'codex', selectedRepositoryIds: project.repositories.slice(0, count).map((repo: any) => repo.id) } });
  assert.equal(response.statusCode, 201); return response.json();
}

async function terminal(store: any, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = store.getJob(id); if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('job did not reach a terminal state');
}

test('single-repository Codex execution uses safe CLI arguments and parses JSONL', async () => {
  const { app, store, project, capture, root } = await fixture(); const job = await createJob(app, project, 'Do the work');
  assert.equal((await terminal(store, job.id)).status, 'done');
  const events = store.events(job.id); assert.equal(events.find((event: any) => event.type === 'session')?.data.threadId, 'thread-test');
  assert.equal(events.filter((event: any) => event.type === 'progress' && event.message.includes('Fake')).length, 2);
  assert.equal(events.find((event: any) => event.type === 'final_response')?.message, 'Fake final response');
  assert.equal(events.filter((event: any) => event.type === 'final_response').length, 1);
  assert.deepEqual(events.find((event: any) => event.type === 'token_usage')?.data, { input_tokens: 12, output_tokens: 4 });
  assert.equal(events.find((event: any) => event.type === 'command')?.data.exit_code, 2);
  const captured = JSON.parse(readFileSync(capture, 'utf8'));
  assert.deepEqual(captured.args.slice(0, 7), ['exec', '--json', '--ephemeral', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-c']);
  assert.ok(captured.prompt.includes(join(root, 'runs', job.id))); assert.ok(!('OPENAI_API_KEY' in captured.env));
});

test('multi-repository execution creates isolated worktrees and collects changes per repository', async () => {
  const { app, store, project, root, repoA, repoB } = await fixture(); const job = await createJob(app, project, 'CHANGE_FILES', 2);
  assert.equal((await terminal(store, job.id)).status, 'done');
  const results = store.events(job.id).filter((event: any) => event.type === 'repository_result'); assert.equal(results.length, 2);
  const branches = new Set(results.map((result: any) => result.data.branch));
  assert.equal(branches.size, 1);
  for (const result of results) { assert.match(result.data.branch, new RegExp(`^remote-engineer/${job.id}/[0-9a-f-]{36}$`)); assert.deepEqual(result.data.changedFiles, ['README.md']); assert.match(result.data.diffStat, /README.md/); assert.ok(result.data.directory.startsWith(join(root, 'runs', job.id))); }
  assert.equal(readFileSync(join(repoA, 'README.md'), 'utf8'), 'repo-a\n'); assert.equal(readFileSync(join(repoB, 'README.md'), 'utf8'), 'repo-b\n');
});

test('retrying the same job creates a new attempt without disturbing the retained worktree', async () => {
  const { app, store, project } = await fixture(); const job = await createJob(app, project, 'Do the work');
  assert.equal((await terminal(store, job.id)).status, 'done');
  const first = store.repositoryRuns(job.id)[0];
  // Exercise the same-job retry path used after an agent asks for input.
  store.setStatus(job.id, 'needs_input');
  const reply = await app.inject({ method: 'POST', url: `/jobs/${job.id}/reply`, headers: auth, payload: { message: 'retry' } });
  assert.equal(reply.statusCode, 200);
  assert.equal((await terminal(store, job.id)).status, 'done');
  const second = store.repositoryRuns(job.id)[0];
  assert.notEqual(second.branch, first.branch);
  assert.notEqual(second.worktreePath, first.worktreePath);
  assert.equal(git(first.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), first.branch);
});

test('invalid JSONL is stored as an error event without failing a successful run', async () => {
  const { app, store, project } = await fixture(); const job = await createJob(app, project, 'INVALID_JSON');
  assert.equal((await terminal(store, job.id)).status, 'done'); assert.ok(store.events(job.id).some((event: any) => event.message === 'Received invalid JSONL from Codex'));
});

test('timeout terminates Codex and clearly fails the job', async () => {
  const { app, store, project } = await fixture({ timeout: 50 }); const job = await createJob(app, project, 'WAIT_FOREVER');
  assert.equal((await terminal(store, job.id)).status, 'failed'); assert.match((store.events(job.id).at(-1)?.data as any).error, /timed out/);
});

test('cancellation terminates Codex and preserves cancelled state', async () => {
  const { app, store, project } = await fixture(); const job = await createJob(app, project, 'WAIT_FOREVER');
  while (store.getJob(job.id)?.status !== 'running') await new Promise((resolve) => setTimeout(resolve, 5));
  const response = await app.inject({ method: 'POST', url: `/jobs/${job.id}/cancel`, headers: auth }); assert.equal(response.statusCode, 200);
  assert.equal((await terminal(store, job.id)).status, 'cancelled');
});

test('nonzero Codex exit clearly fails the job', async () => {
  const { app, store, project } = await fixture(); const job = await createJob(app, project, 'EXIT_NONZERO');
  assert.equal((await terminal(store, job.id)).status, 'failed'); assert.match((store.events(job.id).at(-1)?.data as any).error, /code 7/);
});

test('zero exit without turn.completed fails with protocol_incomplete and has no results', async () => {
  const { app, store, project } = await fixture(); const job = await createJob(app, project, 'EXIT_ZERO_INCOMPLETE');
  assert.equal((await terminal(store, job.id)).status, 'failed');
  const events = store.events(job.id);
  assert.match((events.at(-1)?.data as any).error, /protocol_incomplete/);
  assert.equal(events.some((event: any) => event.type === 'final_response'), false);
  assert.equal(events.some((event: any) => event.type === 'repository_result'), false);
});

test('turn.failed fails the job even when the child exits zero', async () => {
  const { app, store, project } = await fixture(); const job = await createJob(app, project, 'TURN_FAILED');
  assert.equal((await terminal(store, job.id)).status, 'failed');
  const events = store.events(job.id);
  assert.ok(events.some((event: any) => event.type === 'error' && event.message === 'model turn failed'));
  assert.equal(events.some((event: any) => event.type === 'repository_result'), false);
});

test('error JSONL event fails the job even when the child exits zero', async () => {
  const { app, store, project } = await fixture(); const job = await createJob(app, project, 'ERROR_EVENT');
  assert.equal((await terminal(store, job.id)).status, 'failed');
  assert.ok(store.events(job.id).some((event: any) => event.type === 'error' && event.message === 'stream protocol error'));
});

test('repository paths are revalidated at execution and non-git paths fail', async () => {
  const { app, store, project, root } = await fixture();
  const nongit = join(root, 'nongit'); mkdirSync(nongit);
  store.db.prepare('UPDATE repositories SET path = ? WHERE id = ?').run(nongit, project.repositories[0].id);
  const job = await createJob(app, project, 'work'); assert.equal((await terminal(store, job.id)).status, 'failed');
  assert.match((store.events(job.id).at(-1)?.data as any).error, /git .*failed/);
});

test('repository symlink escape is rejected when execution revalidates real paths', async () => {
  const { app, store, project, root } = await fixture(); const outside = mkdtempSync(join(tmpdir(), 'outside-repo-')); repository(outside, 'repo');
  const link = join(root, 'escaped'); symlinkSync(join(outside, 'repo'), link);
  store.db.prepare('UPDATE repositories SET path = ? WHERE id = ?').run(link, project.repositories[0].id);
  const job = await createJob(app, project, 'work'); assert.equal((await terminal(store, job.id)).status, 'failed');
  assert.match((store.events(job.id).at(-1)?.data as any).error, /outside WORKSPACE_ROOT/);
});

test('JSONL event translation covers commands, file changes, errors and usage', () => {
  assert.equal(translateCodexEvent({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test' } })?.type, 'command');
  assert.equal(translateCodexEvent({ type: 'item.completed', item: { type: 'file_change', path: 'x.ts' } })?.type, 'file_change');
  assert.equal(translateCodexEvent({ type: 'error', message: 'bad' })?.type, 'error');
  assert.equal(translateCodexEvent({ type: 'turn.completed', usage: { input_tokens: 1 } }).type, 'token_usage');
  const unknown = translateCodexEvent({ type: 'future.event', secret: 'do-not-store', item: { id: 'safe-id', type: 'future-item', text: 'secret' } });
  assert.equal(unknown.type, 'diagnostic');
  assert.deepEqual(unknown.data, { eventType: 'future.event', itemType: 'future-item', itemId: 'safe-id', status: undefined });
});
