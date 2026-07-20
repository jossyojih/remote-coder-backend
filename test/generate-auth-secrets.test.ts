import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateAuthSecretAssignments } from '../src/auth-secret-config.js';
import { verifyPassword } from '../src/auth.js';

function run(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Command failed with exit code ${code}: ${stderr}`)));
    child.stdin.end(input);
  });
}

test('auth generator emits quoted assignments that survive shell sourcing', async () => {
  const password = 'correct horse battery staple';
  const output = await generateAuthSecretAssignments(password);
  const lines = output.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^APP_PASSWORD_HASH='scrypt-v1\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+'$/);
  assert.match(lines[1]!, /^APP_SESSION_SECRET='[A-Za-z0-9_-]{43}'$/);

  const hash = lines[0]!.slice("APP_PASSWORD_HASH='".length, -1);
  assert.equal(await verifyPassword(password, hash), true);

  const directory = mkdtempSync(join(tmpdir(), 'auth-generator-'));
  const envPath = join(directory, '.env');
  writeFileSync(envPath, output, { mode: 0o600 });
  await run('/bin/sh', ['-c',
    '. "$1"; test "$APP_PASSWORD_HASH" = "$2"; test -n "$APP_SESSION_SECRET"',
    'sh', envPath, hash,
  ]);
});
