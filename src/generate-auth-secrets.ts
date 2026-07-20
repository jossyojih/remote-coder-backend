import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { hashPassword } from './auth.js';

async function readPassword(): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = []; for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
  }
  const rl = createInterface({ input: stdin, output: stdout });
  stdout.write('App password (input is hidden): '); stdin.setRawMode(true);
  let value = '';
  try {
    for await (const chunk of stdin) {
      const text = String(chunk);
      if (text.includes('\u0003')) throw new Error('Cancelled');
      if (text.includes('\r') || text.includes('\n')) break;
      if (text.includes('\u007f')) value = value.slice(0, -1); else value += text;
    }
  } finally { stdin.setRawMode(false); rl.close(); stdout.write('\n'); }
  return value;
}

const password = await readPassword();
if (password.length < 12) throw new Error('Use an app password of at least 12 characters');
stdout.write(`APP_PASSWORD_HASH=${await hashPassword(password)}\nAPP_SESSION_SECRET=${randomBytes(32).toString('base64url')}\n`);
