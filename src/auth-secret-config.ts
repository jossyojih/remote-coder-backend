import { randomBytes } from 'node:crypto';
import { hashPassword } from './auth.js';

const quoteEnvValue = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export async function generateAuthSecretAssignments(password: string): Promise<string> {
  if (password.length < 12) throw new Error('Use an app password of at least 12 characters');
  return `APP_PASSWORD_HASH=${quoteEnvValue(await hashPassword(password))}\nAPP_SESSION_SECRET=${quoteEnvValue(randomBytes(32).toString('base64url'))}\n`;
}
