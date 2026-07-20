import { z } from 'zod';

export const idParamsSchema = z.object({ id: z.string().uuid() });

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  repositories: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    path: z.string().trim().min(1),
  })).min(1),
});

export const createJobSchema = z.object({
  projectId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(100_000),
  scopeMode: z.enum(['auto', 'manual', 'all']).default('auto'),
  requestedRepositoryIds: z.array(z.string().uuid()).optional(),
  selectedRepositoryIds: z.array(z.string().uuid()).optional(),
  agent: z.enum(['mock', 'codex', 'claude']).optional(),
}).superRefine((value, context) => {
  const ids = value.requestedRepositoryIds ?? value.selectedRepositoryIds ?? [];
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'Repository IDs must be unique' });
  }
  if (value.scopeMode === 'manual' && ids.length === 0) context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'Manual scope requires at least one repository' });
  if (value.scopeMode === 'all' && ids.length > 0) context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'All scope does not accept repository selections' });
});

export const replySchema = z.object({
  message: z.string().trim().min(1).max(100_000),
});

export const scopeDecisionSchema = z.object({ decision: z.enum(['approve', 'reject']) });

export const followUpSchema = z.object({
  message: z.string().trim().min(1).max(100_000),
  requestId: z.string().uuid(),
});
