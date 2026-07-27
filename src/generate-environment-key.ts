import { randomBytes } from 'node:crypto';
import { constants, openSync, writeFileSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';

const requested = process.argv[2];
if (!requested) {
  process.stderr.write('Usage: npm run generate:env-key -- /protected/path/repository-env.key\n');
  process.exitCode = 2;
} else {
  const path = resolve(requested);
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(descriptor, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8' }); }
  finally { closeSync(descriptor); }
  process.stdout.write(`Created environment encryption key at ${path} with mode 0600.\n`);
}
