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
  selectedRepositoryIds: z.array(z.string().uuid()).min(1),
  agent: z.enum(['mock', 'codex', 'claude']).default('mock'),
}).superRefine((value, context) => {
  if (new Set(value.selectedRepositoryIds).size !== value.selectedRepositoryIds.length) {
    context.addIssue({ code: 'custom', path: ['selectedRepositoryIds'], message: 'Repository IDs must be unique' });
  }
});

export const replySchema = z.object({
  message: z.string().trim().min(1).max(100_000),
});

export const followUpSchema = z.object({
  message: z.string().trim().min(1).max(100_000),
  requestId: z.string().uuid(),
});
