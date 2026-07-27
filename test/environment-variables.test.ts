import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Store } from '../src/database.js';
import {
  decryptValue, encryptValue, EnvironmentVariableService, loadMasterKey, parseDotenv, validateVariableName,
} from '../src/environment-variables.js';
import { buildApp } from '../src/app.js';
import { redactEnvironmentSecrets } from '../src/agent-runtime.js';
import { validateRepository } from '../src/validation.js';

const key = Buffer.alloc(32, 7);

describe('environment variable cryptography', () => {
  test('encrypts, decrypts, and detects ciphertext or context tampering', () => {
    const context = { projectId: 'p', repositoryId: 'r', environment: 'development' as const, name: 'TOKEN' };
    const encrypted = encryptValue(key, 'not-a-real-secret', context);
    const row = { project_id: 'p', repository_id: 'r', environment: 'development' as const, name: 'TOKEN', ciphertext: encrypted.ciphertext, iv: encrypted.iv, auth_tag: encrypted.authTag, key_version: 1 };
    assert.equal(decryptValue(key, row), 'not-a-real-secret');
    assert.throws(() => decryptValue(key, { ...row, name: 'OTHER' }));
    const tampered = Buffer.from(row.ciphertext); tampered[0] ^= 1;
    assert.throws(() => decryptValue(key, { ...row, ciphertext: tampered }));
    assert.throws(() => decryptValue(Buffer.alloc(32, 8), row));
  });

  test('fails closed for missing, unsafe, and malformed key files', () => {
    const root = mkdtempSync(join(tmpdir(), 'env-key-')); const path = join(root, 'key');
    assert.throws(() => loadMasterKey(path));
    writeFileSync(path, key.toString('hex'), { mode: 0o644 });
    chmodSync(path, 0o644);
    assert.throws(() => loadMasterKey(path), /permissions/);
    chmodSync(path, 0o600); assert.deepEqual(loadMasterKey(path), key);
    writeFileSync(path, 'short', { mode: 0o600 }); assert.throws(() => loadMasterKey(path), /32 bytes/);
  });
});

describe('dotenv parser and validation', () => {
  test('parses common syntax and multiline values without evaluation', () => {
    assert.deepEqual(parseDotenv("export A=one # comment\nB='two words'\nC=\"line\\nnext\"\n"), [
      { key: 'A', value: 'one' }, { key: 'B', value: 'two words' }, { key: 'C', value: 'line\nnext' },
    ]);
    assert.throws(() => parseDotenv('A=$(whoami)'), /substitution/);
    assert.throws(() => parseDotenv('A=`whoami`'), /substitution/);
    assert.throws(() => parseDotenv('A=1\nA=2'), /Duplicate/);
    assert.throws(() => parseDotenv('not valid'), /Malformed/);
    assert.throws(() => parseDotenv(`A=${'x'.repeat(33_000)}`), /too large/);
  });
  test('blocks service, system, credential, runner, and deployment control names', () => {
    for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'GIT_ASKPASS', 'GIT_CREDENTIAL_HELPER', 'RUNNER_API_TOKEN', 'DEPLOYMENT_API_TOKEN', 'REPOSITORY_ENV_KEY_PATH']) {
      assert.throws(() => validateVariableName(name), /Reserved/);
    }
    assert.doesNotThrow(() => validateVariableName('APP_FEATURE_FLAG'));
  });
});

describe('storage, inheritance, rotation, redaction, and API masking', () => {
  function fixture() {
    const store = new Store(':memory:');
    const project = store.createProject('P', [{ name: 'R', path: '/tmp/r' }]);
    const service = new EnvironmentVariableService(store.db, new Map([[1, key]]));
    return { store, project, repositoryId: project.repositories[0]!.id, service };
  }
  test('separates environments and applies repository overrides', () => {
    const { service, project, repositoryId } = fixture();
    service.save({ projectId: project.id, environment: 'development', key: 'A', value: 'alpha-fixture', classification: 'secret', allowAgentAccess: false });
    service.save({ projectId: project.id, repositoryId, environment: 'development', key: 'A', value: 'beta-fixture', classification: 'secret', allowAgentAccess: true });
    service.save({ projectId: project.id, environment: 'test', key: 'A', value: 'gamma-fixture', classification: 'public', allowAgentAccess: false });
    assert.deepEqual(service.resolve(project.id, repositoryId, 'development'), { A: 'beta-fixture' });
    assert.deepEqual(service.resolve(project.id, repositoryId, 'development', true), { A: 'beta-fixture' });
    assert.deepEqual(service.resolve(project.id, repositoryId, 'test'), { A: 'gamma-fixture' });
    const listed = service.list(project.id, repositoryId, 'development');
    assert.equal(listed[0]!.inherited, true); assert.equal(listed[0]!.overridden, true);
    assert.doesNotMatch(JSON.stringify(listed), /alpha-fixture|beta-fixture|gamma-fixture/);
  });
  test('denies agent access by default and rotates without exposing plaintext', () => {
    const { service, store, project, repositoryId } = fixture();
    service.save({ projectId: project.id, environment: 'development', key: 'DENIED', value: 'hidden', classification: 'secret', allowAgentAccess: false });
    assert.deepEqual(service.resolve(project.id, repositoryId, 'development', true), {});
    const next = Buffer.alloc(32, 9);
    assert.equal(service.rotate(2, next), 1);
    const rotated = new EnvironmentVariableService(store.db, new Map([[2, next]]), 2);
    assert.deepEqual(rotated.resolve(project.id, repositoryId, 'development'), { DENIED: 'hidden' });
    assert.doesNotMatch(JSON.stringify(store.db.prepare('SELECT * FROM environment_variable_audit').all()), /hidden/);
  });
  test('API responses and logs never return saved or imported values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'env-api-')); const repo = join(root, 'repo');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(repo));
    let logs = ''; const loggerStream = { write(chunk: string) { logs += chunk; return true; } } as any;
    const built = await buildApp({ databasePath: ':memory:', workspaceRoot: root, apiToken: 'token', repositoryEnvKey: key, loggerStream });
    const auth = { authorization: 'Bearer token' };
    const project = (await built.app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'P', repositories: [{ name: 'R', path: repo }] } })).json();
    const base = `/projects/${project.id}/environments/development/variables`;
    const secret = 'fixture-value-never-production';
    const created = await built.app.inject({ method: 'POST', url: base, headers: auth, payload: { key: 'SAFE_TOKEN', value: secret, classification: 'secret', allowAgentAccess: false } });
    assert.equal(created.statusCode, 201); assert.doesNotMatch(created.body, new RegExp(secret));
    const listed = await built.app.inject({ url: base, headers: auth }); assert.doesNotMatch(listed.body, new RegExp(secret));
    const preview = await built.app.inject({ method: 'POST', url: `${base}/import`, headers: auth, payload: { content: `OTHER=${secret}`, confirm: false } });
    assert.deepEqual(preview.json().variables, [{ key: 'OTHER' }]);
    assert.doesNotMatch(logs, new RegExp(secret));
    await built.app.close();
  });
  test('redacts values from nested events and validation output', async () => {
    const secret = 'validation-fixture-secret';
    assert.deepEqual(redactEnvironmentSecrets({ message: secret, nested: [secret] }, { TOKEN: secret }), { message: '[REDACTED]', nested: ['[REDACTED]'] });
    const result = await validateRepository({ id: 'r', projectId: 'p', name: 'R', path: '.', createdAt: '', effectivePromotionPolicy: 'review_required' }, process.cwd(), {
      enabled: true, commands: [{ command: 'env', args: [], description: 'redaction' }],
    }, { SAFE_TOKEN: secret });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.match(result.results[0]!.stdout, /REDACTED/);
  });
});
