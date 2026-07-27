import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export type VariableClassification = 'secret' | 'public';
export const ENV_LIMITS = { maxVariablesPerScope: 200, maxValueBytes: 32_768, maxImportBytes: 256_000, maxImportVariables: 200 };

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'NODE_OPTIONS', 'NODE_PATH',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM', 'GIT_ASKPASS', 'SSH_ASKPASS', 'RUNNER_API_TOKEN', 'DEPLOYMENT_API_TOKEN',
  'REPOSITORY_ENV_KEY_PATH', 'DATABASE_PATH', 'WORKSPACE_ROOT', 'RUNS_ROOT', 'APP_PASSWORD_HASH',
  'APP_SESSION_SECRET', 'CODEX_HOME', 'ANTHROPIC_API_KEY',
]);
const RESERVED_PATTERNS = [
  /^GIT_(?:CREDENTIAL|CONFIG_KEY_|CONFIG_VALUE_|SSH_COMMAND|TERMINAL_PROMPT)/,
  /^(?:RUNNER|DEPLOYMENT|REMOTE_CODER)_.+(?:TOKEN|SECRET|KEY)$/,
  /^(?:AWS|GOOGLE|AZURE)_(?:PROFILE|CONFIG_FILE|SHARED_CREDENTIALS_FILE)$/,
];

export interface EnvironmentVariableMetadata {
  id: string;
  key: string;
  scope: 'project' | 'repository';
  projectId: string;
  repositoryId?: string;
  classification: VariableClassification;
  allowAgentAccess: boolean;
  inherited: boolean;
  overridden: boolean;
  masked: true;
  createdAt: string;
  updatedAt: string;
}
type Row = {
  id: string; project_id: string; repository_id: string | null; environment: string; name: string;
  ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number; classification: VariableClassification;
  allow_agent_access: number; created_at: string; updated_at: string;
};

export class EnvironmentConfigurationError extends Error {}
export class EnvironmentValidationError extends Error { statusCode = 400; }

function decodeKey(raw: Buffer): Buffer {
  const text = raw.toString('utf8').trim();
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : /^[A-Za-z0-9+/]{43}=$/.test(text) ? Buffer.from(text, 'base64') : raw;
  if (key.length !== 32) throw new EnvironmentConfigurationError('Environment encryption key must contain exactly 32 bytes');
  return key;
}

export function loadMasterKey(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new EnvironmentConfigurationError('Environment encryption key path must be a regular file');
  if ((stat.mode & 0o077) !== 0) throw new EnvironmentConfigurationError('Environment encryption key file permissions must be 0600 or stricter');
  return decodeKey(readFileSync(path));
}

export function validateVariableName(name: string): void {
  if (!NAME.test(name)) throw new EnvironmentValidationError(`Invalid environment variable name: ${name}`);
  if (RESERVED_EXACT.has(name) || RESERVED_PATTERNS.some((pattern) => pattern.test(name))) {
    throw new EnvironmentValidationError(`Reserved environment variable name: ${name}`);
  }
}

function aad(projectId: string, repositoryId: string | null, environment: string, name: string, version: number): Buffer {
  return Buffer.from(JSON.stringify([projectId, repositoryId, environment, name, version]));
}

export function encryptValue(key: Buffer, value: string, context: { projectId: string; repositoryId?: string; environment?: string; name: string; keyVersion?: number }) {
  if (Buffer.byteLength(value) > ENV_LIMITS.maxValueBytes) throw new EnvironmentValidationError('Environment variable value is too large');
  const keyVersion = context.keyVersion ?? 1;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(context.projectId, context.repositoryId ?? null, context.environment ?? 'development', context.name, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion };
}

export function decryptValue(key: Buffer, row: Pick<Row, 'project_id' | 'repository_id' | 'environment' | 'name' | 'ciphertext' | 'iv' | 'auth_tag' | 'key_version'>): string {
  const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
  decipher.setAAD(aad(row.project_id, row.repository_id, row.environment, row.name, row.key_version));
  decipher.setAuthTag(row.auth_tag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
}

function stripComment(value: string): string {
  let quote = ''; let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote === '"') { escaped = true; continue; }
    if ((char === '"' || char === "'") && (!quote || quote === char)) { quote = quote ? '' : char; continue; }
    if (char === '#' && !quote && (i === 0 || /\s/.test(value[i - 1]!))) return value.slice(0, i).trimEnd();
  }
  return value;
}

export function parseDotenv(input: string): Array<{ key: string; value: string }> {
  if (Buffer.byteLength(input) > ENV_LIMITS.maxImportBytes) throw new EnvironmentValidationError('Dotenv import is too large');
  if (input.includes('\0') || /\$\(|`/.test(input)) throw new EnvironmentValidationError('Shell command substitution is not allowed');
  const entries: Array<{ key: string; value: string }> = []; const seen = new Set<string>();
  const lines = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/^export\s+/, '');
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new EnvironmentValidationError(`Malformed dotenv input at line ${index + 1}`);
    const key = match[1]!; validateVariableName(key);
    if (seen.has(key)) throw new EnvironmentValidationError(`Duplicate environment variable: ${key}`);
    seen.add(key);
    let raw = stripComment(match[2]!); let value: string;
    if (raw.startsWith('"')) {
      while (!/(?<!\\)"$/.test(raw) && index + 1 < lines.length) raw += `\n${lines[++index]}`;
      if (!/(?<!\\)"$/.test(raw)) throw new EnvironmentValidationError(`Unterminated quoted value for ${key}`);
      try { value = JSON.parse(raw); } catch { throw new EnvironmentValidationError(`Malformed quoted value for ${key}`); }
    } else if (raw.startsWith("'")) {
      while (!raw.endsWith("'") && index + 1 < lines.length) raw += `\n${lines[++index]}`;
      if (!raw.endsWith("'")) throw new EnvironmentValidationError(`Unterminated quoted value for ${key}`);
      value = raw.slice(1, -1);
    } else {
      if (/["']/.test(raw)) throw new EnvironmentValidationError(`Malformed quoted value for ${key}`);
      value = raw;
    }
    if (Buffer.byteLength(value) > ENV_LIMITS.maxValueBytes) throw new EnvironmentValidationError(`Value for ${key} is too large`);
    entries.push({ key, value });
    if (entries.length > ENV_LIMITS.maxImportVariables) throw new EnvironmentValidationError('Dotenv import contains too many variables');
  }
  return entries;
}

export class EnvironmentVariableService {
  constructor(private readonly db: DatabaseSync, private readonly keys: Map<number, Buffer>, private readonly activeKeyVersion = 1) {
    if (!keys.has(activeKeyVersion)) throw new EnvironmentConfigurationError('Active environment encryption key is unavailable');
  }

  private rows(projectId: string, repositoryId?: string): Row[] {
    return this.db.prepare(`SELECT * FROM environment_variables WHERE project_id=? AND
      ${repositoryId ? 'repository_id=?' : 'repository_id IS NULL'} ORDER BY name`).all(...(repositoryId ? [projectId, repositoryId] : [projectId])) as unknown as Row[];
  }
  private metadata(row: Row, inherited = false, overridden = false): EnvironmentVariableMetadata {
    return { id: row.id, key: row.name, scope: row.repository_id ? 'repository' : 'project',
      projectId: row.project_id, repositoryId: row.repository_id ?? undefined, classification: row.classification,
      allowAgentAccess: Boolean(row.allow_agent_access), inherited, overridden, masked: true, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  list(projectId: string, repositoryId?: string): EnvironmentVariableMetadata[] {
    const project = this.rows(projectId);
    if (!repositoryId) return project.map((row) => this.metadata(row));
    const repository = this.rows(projectId, repositoryId); const overrides = new Set(repository.map((row) => row.name));
    return [...project.map((row) => this.metadata(row, true, overrides.has(row.name))), ...repository.map((row) => this.metadata(row))];
  }
  save(input: { projectId: string; repositoryId?: string; key: string; value: string; classification: VariableClassification; allowAgentAccess: boolean }, replace = false): EnvironmentVariableMetadata {
    validateVariableName(input.key);
    if (Object.prototype.hasOwnProperty.call(process.env, input.key)) throw new EnvironmentValidationError(`Service environment variable name is reserved: ${input.key}`);
    if (input.classification !== 'secret' && input.classification !== 'public') throw new EnvironmentValidationError('Invalid variable classification');
    const existing = this.db.prepare('SELECT id FROM environment_variables WHERE project_id=? AND repository_id IS ? AND name=?').get(input.projectId, input.repositoryId ?? null, input.key) as { id: string } | undefined;
    if (Boolean(existing) !== replace) throw new EnvironmentValidationError(existing ? 'Variable already exists; use replace' : 'Variable does not exist');
    if (!existing) {
      const count = this.db.prepare('SELECT COUNT(*) count FROM environment_variables WHERE project_id=? AND repository_id IS ?').get(input.projectId, input.repositoryId ?? null) as { count: number };
      if (count.count >= ENV_LIMITS.maxVariablesPerScope) throw new EnvironmentValidationError('Environment variable limit reached');
    }
    const encrypted = encryptValue(this.keys.get(this.activeKeyVersion)!, input.value, { ...input, name: input.key, keyVersion: this.activeKeyVersion });
    const now = new Date().toISOString(); const id = existing?.id ?? randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (existing) this.db.prepare('UPDATE environment_variables SET ciphertext=?,iv=?,auth_tag=?,key_version=?,classification=?,allow_agent_access=?,updated_at=? WHERE id=?')
        .run(encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyVersion, input.classification, input.allowAgentAccess ? 1 : 0, now, id);
      else this.db.prepare('INSERT INTO environment_variables VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.projectId, input.repositoryId ?? null, 'development', input.key, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyVersion, input.classification, input.allowAgentAccess ? 1 : 0, now, now);
      this.db.prepare('INSERT INTO environment_variable_audit(id,project_id,repository_id,environment,name,action,classification,allow_agent_access,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), input.projectId, input.repositoryId ?? null, 'shared', input.key, existing ? 'replace' : 'create', input.classification, input.allowAgentAccess ? 1 : 0, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.metadata(this.db.prepare('SELECT * FROM environment_variables WHERE id=?').get(id) as unknown as Row);
  }
  delete(projectId: string, repositoryId: string | undefined, name: string): boolean {
    const row = this.db.prepare('SELECT * FROM environment_variables WHERE project_id=? AND repository_id IS ? AND name=?').get(projectId, repositoryId ?? null, name) as unknown as Row | undefined;
    if (!row) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM environment_variables WHERE id=?').run(row.id);
      this.db.prepare('INSERT INTO environment_variable_audit(id,project_id,repository_id,environment,name,action,classification,allow_agent_access,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), projectId, repositoryId ?? null, 'shared', name, 'delete', row.classification, row.allow_agent_access, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return true;
  }
  resolve(projectId: string, repositoryId: string, agentOnly = false): NodeJS.ProcessEnv {
    const merged = new Map(this.rows(projectId).map((row) => [row.name, row]));
    for (const row of this.rows(projectId, repositoryId)) merged.set(row.name, row);
    const output: NodeJS.ProcessEnv = {};
    for (const row of merged.values()) {
      if (agentOnly && !row.allow_agent_access) continue;
      const key = this.keys.get(row.key_version);
      if (!key) throw new EnvironmentConfigurationError(`Encryption key version ${row.key_version} is unavailable`);
      output[row.name] = decryptValue(key, row);
    }
    return output;
  }
  rotate(newVersion: number, newKey: Buffer): number {
    if (!Number.isInteger(newVersion) || newVersion <= this.activeKeyVersion || newKey.length !== 32) throw new EnvironmentValidationError('Invalid rotation key version');
    const rows = this.db.prepare('SELECT * FROM environment_variables').all() as unknown as Row[]; this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const oldKey = this.keys.get(row.key_version); if (!oldKey) throw new EnvironmentConfigurationError(`Encryption key version ${row.key_version} is unavailable`);
        const encrypted = encryptValue(newKey, decryptValue(oldKey, row), { projectId: row.project_id, repositoryId: row.repository_id ?? undefined, environment: row.environment, name: row.name, keyVersion: newVersion });
        this.db.prepare('UPDATE environment_variables SET ciphertext=?,iv=?,auth_tag=?,key_version=?,updated_at=? WHERE id=?').run(encrypted.ciphertext, encrypted.iv, encrypted.authTag, newVersion, new Date().toISOString(), row.id);
      }
      this.db.exec('COMMIT'); return rows.length;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
