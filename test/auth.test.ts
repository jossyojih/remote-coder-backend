import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';

const apps: FastifyInstance[] = [];
const password = 'correct horse battery staple';
const runnerToken = 'runner-token-must-not-appear';
const sessionSecret = 'session-secret-must-not-appear-123456789';
const origin = 'https://pwa.example';
async function fixture(overrides: Parameters<typeof buildApp>[0] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'command-center-auth-')); mkdirSync(join(root, 'repo'));
  const built = await buildApp({ databasePath: join(root, 'test.sqlite'), workspaceRoot: root, apiToken: runnerToken, appPasswordHash: await hashPassword(password), appSessionSecret: sessionSecret, appTokenTtlSeconds: 60, appOrigins: [origin], mockStepDelayMs: 10, ...overrides });
  apps.push(built.app); return { ...built, root };
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
async function login(app: FastifyInstance, candidate = password) {
  return app.inject({ method: 'POST', url: '/auth/login', headers: { origin }, payload: { password: candidate } });
}

test('login succeeds without cookies and its access token authenticates protected routes', async () => {
  const { app } = await fixture(); const response = await login(app);
  assert.equal(response.statusCode, 200); assert.equal(response.headers['set-cookie'], undefined);
  assert.match(response.json().expiresAt, /Z$/); assert.equal(typeof response.json().accessToken, 'string');
  const protectedResponse = await app.inject({ url: '/projects', headers: { origin, authorization: `Bearer ${response.json().accessToken}` } });
  assert.equal(protectedResponse.statusCode, 200); assert.equal(protectedResponse.headers['access-control-allow-origin'], origin);
});

test('login rejects wrong passwords and malformed bodies', async () => {
  const { app } = await fixture();
  assert.equal((await login(app, 'wrong password')).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/login', headers: { origin }, payload: {} })).statusCode, 401);
});

test('access tokens expire and tampering invalidates them', async () => {
  let now = 1_800_000_000_000; const { app } = await fixture({ now: () => now, appTokenTtlSeconds: 2 });
  const token = (await login(app)).json().accessToken as string;
  assert.equal((await app.inject({ url: '/projects', headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.equal((await app.inject({ url: '/projects', headers: { authorization: `Bearer ${tampered}` } })).statusCode, 401);
  now += 2_000;
  assert.equal((await app.inject({ url: '/projects', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
});

test('rate limits login attempts per client within the configured window', async () => {
  let now = 1_800_000_000_000; const { app } = await fixture({ now: () => now, loginRateLimit: 2, loginRateWindowMs: 1_000 });
  assert.equal((await login(app, 'bad-one')).statusCode, 401); assert.equal((await login(app, 'bad-two')).statusCode, 401);
  const limited = await login(app); assert.equal(limited.statusCode, 429); assert.equal(limited.headers['retry-after'], '1');
  now += 1_001; assert.equal((await login(app)).statusCode, 200);
});

test('CORS allows exact configured origins, handles preflight, and rejects others', async () => {
  const { app } = await fixture();
  const preflight = await app.inject({ method: 'OPTIONS', url: '/projects', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
  assert.equal(preflight.statusCode, 204); assert.equal(preflight.headers['access-control-allow-origin'], origin); assert.match(preflight.headers['access-control-allow-headers'] ?? '', /Authorization/);
  assert.equal((await app.inject({ url: '/health', headers: { origin: 'https://evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'OPTIONS', url: '/projects' })).statusCode, 400);
});

test('existing runner bearer tokens remain compatible', async () => {
  const { app } = await fixture();
  assert.equal((await app.inject({ url: '/projects', headers: { authorization: `Bearer ${runnerToken}` } })).statusCode, 200);
});

test('SSE responses carry browser CORS headers when authenticated with an app token', async () => {
  const { app, root } = await fixture(); const accessToken = (await login(app)).json().accessToken;
  const headers = { origin, authorization: `Bearer ${accessToken}` };
  const createdProject = await app.inject({ method: 'POST', url: '/projects', headers, payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'repo') }] } });
  const project = createdProject.json(); const createdJob = await app.inject({ method: 'POST', url: '/jobs', headers, payload: { projectId: project.id, prompt: 'safe test prompt', selectedRepositoryIds: [project.repositories[0].id] } });
  const stream = await app.inject({ url: `/jobs/${createdJob.json().id}/events`, headers });
  assert.equal(stream.statusCode, 200); assert.equal(stream.headers['access-control-allow-origin'], origin); assert.match(stream.headers['content-type'] ?? '', /text\/event-stream/);
});

test('request logs redact credentials and sensitive request fields', async () => {
  let output = ''; const sink = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const { app, root } = await fixture({ loggerStream: sink });
  const issuedToken = (await login(app)).json().accessToken as string;
  app.log.info({ req: { headers: { authorization: `Bearer ${runnerToken}` }, body: { password, prompt: 'prompt-must-not-appear' } }, res: { body: { accessToken: issuedToken } } }, 'redaction probe');
  await app.inject({ method: 'POST', url: '/projects', headers: { authorization: `Bearer ${runnerToken}` }, payload: { name: 'P', repositories: [{ name: 'R', path: join(root, 'repo') }] } });
  assert.doesNotMatch(output, new RegExp(password)); assert.doesNotMatch(output, new RegExp(runnerToken)); assert.doesNotMatch(output, new RegExp(sessionSecret));
  assert.doesNotMatch(output, /prompt-must-not-appear/); assert.doesNotMatch(output, new RegExp(issuedToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
