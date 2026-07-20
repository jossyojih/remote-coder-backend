import { basename } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Repository, ScopeReason } from './types.js';

export interface ScopePlan { repositoryIds: string[]; reasons: ScopeReason[] }

// Deliberately bounded and read-only: repository metadata and the user request are
// considered once. No worktree or agent task exists until this plan is persisted.
export class RepositoryScopePlanner {
  describe(repository: Repository): string { return this.metadata(repository).summary; }

  plan(prompt: string, repositories: Repository[]): ScopePlan {
    const text = prompt.toLocaleLowerCase();
    const broad = /\b(all repositories|all repos|every repo|both repositories|both repos|end[- ]to[- ]end|across (?:the )?(?:project|repositories|repos)|frontend and backend|backend and frontend)\b/.test(text);
    const metadata = new Map(repositories.map((repository) => [repository.id, this.metadata(repository)]));
    const wantsFrontend = /\b(frontend|front-end|ui|react|vite|route|component|page|client|browser|css)\b/.test(text);
    const wantsBackend = /\b(backend|back-end|api|fastify|database|sqlite|migration|worker|server|endpoint)\b/.test(text);
    const matches = repositories.filter((repository) => {
      const labels = [repository.name, basename(repository.path)].map((value) => value.toLocaleLowerCase()).filter((value) => value.length >= 2);
      const facts = metadata.get(repository.id)!;
      return labels.some((label) => text.includes(label))
        || (wantsFrontend && facts.frontend)
        || (wantsBackend && facts.backend);
    });
    const selected = broad ? repositories : matches.length ? matches : repositories.slice(0, 1);
    return {
      repositoryIds: selected.map((repository) => repository.id),
      reasons: selected.map((repository) => ({ repositoryId: repository.id, reason: broad
        ? 'The request explicitly spans the project or multiple repository roles.'
        : matches.includes(repository) ? `The request matches ${repository.name} (${metadata.get(repository.id)!.summary}).` : `Best bounded-metadata match (${metadata.get(repository.id)!.summary}).` })),
    };
  }

  private metadata(repository: Repository): { frontend: boolean; backend: boolean; summary: string } {
    let manifest = ''; let directories: string[] = [];
    try {
      const path = `${repository.path}/package.json`;
      if (existsSync(path)) manifest = readFileSync(path, 'utf8').slice(0, 32_000).toLocaleLowerCase();
      directories = readdirSync(repository.path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).slice(0, 100).map((entry) => entry.name.toLocaleLowerCase());
    } catch { /* Missing or unreadable metadata is a valid bounded fingerprint. */ }
    const frontend = /"(react|react-dom|vite|next|vue|svelte|@angular\/core)"/.test(manifest) || directories.some((name) => /^(pages?|routes?|components?|public)$/.test(name));
    const backend = /"(fastify|express|koa|hapi|better-sqlite3|pg|prisma)"/.test(manifest) || directories.some((name) => /^(api|server|database|migrations?|workers?)$/.test(name));
    const roles = [frontend && 'frontend', backend && 'backend'].filter(Boolean).join(' and ') || 'general repository';
    return { frontend, backend, summary: `${roles}; package manifest and top-level source structure inspected` };
  }
}
