import { basename } from 'node:path';
import type { Repository, ScopeReason } from './types.js';

export interface ScopePlan { repositoryIds: string[]; reasons: ScopeReason[] }

// Deliberately bounded and read-only: repository metadata and the user request are
// considered once. No worktree or agent task exists until this plan is persisted.
export class RepositoryScopePlanner {
  plan(prompt: string, repositories: Repository[]): ScopePlan {
    const text = prompt.toLocaleLowerCase();
    const broad = /\b(all repositories|all repos|every repo|both repositories|both repos|end[- ]to[- ]end|across (?:the )?(?:project|repositories|repos)|frontend and backend|backend and frontend)\b/.test(text);
    const matches = repositories.filter((repository) => {
      const labels = [repository.name, basename(repository.path)].map((value) => value.toLocaleLowerCase()).filter((value) => value.length >= 2);
      return labels.some((label) => text.includes(label))
        || (/\b(frontend|front-end|ui|client)\b/.test(text) && labels.some((label) => /front|client|ui|web/.test(label)))
        || (/\b(backend|back-end|api|server)\b/.test(text) && labels.some((label) => /back|api|server/.test(label)));
    });
    const selected = broad ? repositories : matches.length ? matches : repositories.slice(0, 1);
    return {
      repositoryIds: selected.map((repository) => repository.id),
      reasons: selected.map((repository) => ({ repositoryId: repository.id, reason: broad
        ? 'The request explicitly spans the project or multiple repository roles.'
        : matches.includes(repository) ? `The request refers to ${repository.name} or its role.` : 'Best matching repository for the requested work.' })),
    };
  }
}
