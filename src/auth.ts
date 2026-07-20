import { createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
const HASH_PREFIX = 'scrypt-v1';
const KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
function scrypt(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => nodeScrypt(password, salt, length, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key)));
}

export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error('Password must not be empty');
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return [HASH_PREFIX, SCRYPT_OPTIONS.N, SCRYPT_OPTIONS.r, SCRYPT_OPTIONS.p, salt.toString('base64url'), derived.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const [prefix, rawN, rawR, rawP, rawSalt, rawHash, extra] = encoded.split('$');
    if (prefix !== HASH_PREFIX || extra !== undefined || !rawSalt || !rawHash) return false;
    const N = Number(rawN); const r = Number(rawR); const p = Number(rawP);
    if (N !== SCRYPT_OPTIONS.N || r !== SCRYPT_OPTIONS.r || p !== SCRYPT_OPTIONS.p) return false;
    const expected = Buffer.from(rawHash, 'base64url');
    if (expected.length !== KEY_LENGTH) return false;
    const actual = await scrypt(password, Buffer.from(rawSalt, 'base64url'), expected.length);
    return timingSafeEqual(actual, expected);
  } catch { return false; }
}

function encode(value: object): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function signature(value: string, secret: string): Buffer { return createHmac('sha256', secret).update(value).digest(); }

export function issueAccessToken(secret: string, ttlSeconds: number, nowMs = Date.now()): { accessToken: string; expiresAt: string } {
  const now = Math.floor(nowMs / 1000); const exp = now + ttlSeconds;
  const payload = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'app', iat: now, exp, jti: randomBytes(16).toString('base64url') })}`;
  return { accessToken: `${payload}.${signature(payload, secret).toString('base64url')}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyAccessToken(token: string, secret: string, nowMs = Date.now()): boolean {
  try {
    const parts = token.split('.'); if (parts.length !== 3) return false;
    const payload = `${parts[0]}.${parts[1]}`; const supplied = Buffer.from(parts[2]!, 'base64url'); const expected = signature(payload, secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { sub?: unknown; exp?: unknown; iat?: unknown };
    const now = Math.floor(nowMs / 1000);
    return claims.sub === 'app' && Number.isInteger(claims.iat) && typeof claims.exp === 'number' && claims.exp > now && (claims.iat as number) <= now + 30;
  } catch { return false; }
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  constructor(private readonly maximum = 5, private readonly windowMs = 60_000, private readonly now = Date.now) {}
  consume(key: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter((time) => time > cutoff);
    if (recent.length >= this.maximum) { this.attempts.set(key, recent); return false; }
    recent.push(this.now()); this.attempts.set(key, recent); return true;
  }
}
