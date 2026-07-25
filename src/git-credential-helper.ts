import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface SecureCloneOptions {
  url: string;
  targetPath: string;
  token: string;
  timeoutMs?: number;
}

export function createCredentialHelper(token: string, helperDir: string): { helperPath: string; cleanup: () => void } {
  mkdirSync(helperDir, { recursive: true, mode: 0o700 });

  const helperPath = join(helperDir, `git-credential-helper-${randomBytes(8).toString('hex')}`);
  const helperScript = `#!/bin/sh\necho "username=x-access-token"\necho "password=${token}"\n`;

  writeFileSync(helperPath, helperScript, { mode: 0o700 });
  chmodSync(helperPath, 0o700);

  const cleanup = () => {
    try {
      rmSync(helperPath, { force: true });
    } catch {
      // best effort
    }
  };

  return { helperPath, cleanup };
}

export function cloneWithToken(options: SecureCloneOptions): void {
  const helperDir = join('/tmp', `git-helper-${randomBytes(8).toString('hex')}`);
  const { helperPath, cleanup } = createCredentialHelper(options.token, helperDir);

  try {
    const httpsUrl = options.url
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/\.git$/, '') + '.git';

    execFileSync('git', ['clone', '--', httpsUrl, options.targetPath], {
      timeout: options.timeoutMs ?? 120_000,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: helperPath,
      },
    });

    execFileSync('git', ['-C', options.targetPath, 'remote', 'set-url', 'origin', options.url], {
      timeout: 5_000,
      stdio: 'pipe',
    });
  } finally {
    cleanup();
    try {
      rmSync(helperDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
