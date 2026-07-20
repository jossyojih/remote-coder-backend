import { z } from 'zod';

export const idParamsSchema = z.object({ id: z.string().uuid() });
export const projectRepositoryParamsSchema = z.object({ id: z.string().uuid(), repositoryId: z.string().uuid() });
export const promotionPolicySchema = z.enum(['review_required', 'auto_push', 'read_only']);
export const updateProjectPromotionPolicySchema = z.object({ promotionPolicy: promotionPolicySchema });
export const updateRepositoryPromotionPolicySchema = z.object({ promotionPolicyOverride: promotionPolicySchema.nullable() });

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  repositories: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    path: z.string().trim().min(1),
    remoteName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).default('origin'),
    targetBranch: z.string().trim().min(1).max(255).optional(),
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

export const scopeDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'choose']),
  requestedRepositoryIds: z.array(z.string().uuid()).optional(),
}).superRefine((value, context) => {
  const ids = value.requestedRepositoryIds ?? [];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'Repository IDs must be unique' });
  if (value.decision === 'choose' && ids.length === 0) context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'Choose at least one repository' });
  if (value.decision !== 'choose' && ids.length) context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'Repository selections require choose' });
});

export const followUpSchema = z.object({
  message: z.string().trim().min(1).max(100_000),
  requestId: z.string().uuid(),
  scopeMode: z.enum(['auto', 'manual', 'all']).optional(),
  requestedRepositoryIds: z.array(z.string().uuid()).optional(),
}).superRefine((value, context) => {
  const ids = value.requestedRepositoryIds ?? [];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'Repository IDs must be unique' });
  if (value.scopeMode === 'manual' && ids.length === 0) context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'Manual scope requires at least one repository' });
  if (value.scopeMode !== 'manual' && ids.length > 0) context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'Repository selections require manual scope' });
});

export const promoteJobSchema = z.object({
  commitMessage: z.string().trim().min(1).max(500).refine((value) => !value.includes('\0'), 'Commit message contains an invalid character'),
  approvedRepositoryIds: z.array(z.string().uuid()).min(1).max(100),
}).superRefine((value, context) => {
  if (new Set(value.approvedRepositoryIds).size !== value.approvedRepositoryIds.length)
    context.addIssue({ code: 'custom', path: ['approvedRepositoryIds'], message: 'Repository IDs must be unique' });
});
