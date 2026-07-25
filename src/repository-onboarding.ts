import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cloneWithToken } from './git-credential-helper.js';

export interface OnboardingResult {
  clonePath: string;
  defaultBranch: string;
}

export interface CloneOptions {
  token?: string;
}

const GITHUB_URL_PATTERNS = [
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
];

export function parseGitHubUrl(url: string): { owner: string; repo: string; normalized: string } | null {
  const trimmed = url.trim();
  for (const pattern of GITHUB_URL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const owner = match[1]!;
      const repo = match[2]!;
      return { owner, repo, normalized: `git@github.com:${owner}/${repo}.git` };
    }
  }
  return null;
}

export function extractGitHubUrlFromOrigin(repoPath: string): string | null {
  try {
    const originUrl = execFileSync('git', ['-C', repoPath, 'config', '--get', 'remote.origin.url'], {
      timeout: 5000,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();

    if (!originUrl) return null;

    // Strip credentials, query strings, fragments
    let cleaned = originUrl.replace(/^(https?:\/\/)[^@]*@/, '$1');
    cleaned = cleaned.replace(/\?.*$/, '').replace(/#.*$/, '');

    const parsed = parseGitHubUrl(cleaned);
    if (!parsed) return null;

    // Return normalized HTTPS URL
    return `https://github.com/${parsed.owner}/${parsed.repo}`;
  } catch {
    return null;
  }
}

export function validateRepositoryUrl(url: string): { valid: true; owner: string; repo: string; normalized: string } | { valid: false; error: string } {
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, error: 'Repository URL is required' };
  if (/[:@].*[:@]/.test(trimmed) && !trimmed.startsWith('git@')) return { valid: false, error: 'Embedded credentials are not allowed' };
  if (/\/\/[^@/]*:[^@/]*@/.test(trimmed)) return { valid: false, error: 'Embedded credentials are not allowed' };
  if (trimmed.includes('..')) return { valid: false, error: 'Malformed repository URL' };
  const parsed = parseGitHubUrl(trimmed);
  if (!parsed) return { valid: false, error: 'Only github.com SSH or HTTPS repository URLs are supported' };
  if (/[^A-Za-z0-9_.\-/]/.test(parsed.owner) || /[^A-Za-z0-9_.\-/]/.test(parsed.repo)) return { valid: false, error: 'Malformed repository URL' };
  return { valid: true, ...parsed };
}

export function safeDirName(owner: string, repo: string): string {
  const base = `${owner}--${repo}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return `${base}--${randomUUID().slice(0, 8)}`;
}

export function validateClonePath(target: string, workspaceRoot: string): void {
  const root = realpathSync(workspaceRoot);
  const abs = resolve(root, target);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Clone destination escapes workspace root');
  if (existsSync(abs)) {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) throw new Error('Clone destination is a symlink');
  }
}

export function cloneRepository(url: string, target: string, workspaceRoot: string, options?: CloneOptions): OnboardingResult {
  const root = realpathSync(workspaceRoot);
  const abs = resolve(root, target);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Clone destination escapes workspace root');
  if (rel.includes('..')) throw new Error('Path traversal detected');

  mkdirSync(abs, { recursive: true });

  try {
    if (options?.token) {
      cloneWithToken({ url, targetPath: abs, token: options.token, timeoutMs: 120_000 });
    } else {
      execFileSync('git', ['clone', '--', url, abs], {
        timeout: 120_000,
        stdio: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    }
  } catch {
    rmSync(abs, { recursive: true, force: true });
    throw new Error('Clone failed');
  }

  const realClone = realpathSync(abs);
  const cloneRel = relative(root, realClone);
  if (cloneRel.startsWith('..') || isAbsolute(cloneRel)) {
    rmSync(abs, { recursive: true, force: true });
    throw new Error('Clone destination escapes workspace root after resolution');
  }

  if (!existsSync(join(realClone, '.git'))) {
    rmSync(abs, { recursive: true, force: true });
    throw new Error('Cloned directory is not a valid Git repository');
  }

  let defaultBranch: string;
  try {
    const headRef = execFileSync('git', ['-C', realClone, 'symbolic-ref', '--short', 'HEAD'], {
      timeout: 10_000,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
    defaultBranch = headRef || 'main';
  } catch {
    defaultBranch = 'main';
  }

  return { clonePath: realClone, defaultBranch };
}

export function cleanupFailedClone(target: string, workspaceRoot: string): void {
  try {
    const root = realpathSync(workspaceRoot);
    const abs = resolve(root, target);
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return;
    if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
  } catch { /* best effort */ }
}
