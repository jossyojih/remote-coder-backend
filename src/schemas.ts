import { z } from 'zod';

export const idParamsSchema = z.object({ id: z.string().uuid() });
export const projectRepositoryParamsSchema = z.object({ id: z.string().uuid(), repositoryId: z.string().uuid() });
export const promotionPolicySchema = z.enum(['review_required', 'auto_push', 'read_only']);
export const updateProjectPromotionPolicySchema = z.object({ promotionPolicy: promotionPolicySchema });
export const updateRepositoryPromotionPolicySchema = z.object({ promotionPolicyOverride: promotionPolicySchema.nullable() });
export const agentSelectionSchema = z.object({ agent: z.enum(['mock', 'codex', 'claude']).optional(), model: z.string().max(128).optional(), reasoningLevel: z.enum(['low', 'medium', 'high']).optional() });
export const updateProjectAgentDefaultsSchema = agentSelectionSchema.refine((value) => value.agent !== undefined, { message: 'Agent is required', path: ['agent'] });

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  defaultAgent: z.enum(['mock', 'codex', 'claude']).optional(),
  defaultModel: z.string().max(128).optional(),
  promotionPolicy: promotionPolicySchema.optional(),
  repositories: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    path: z.string().trim().min(1),
    remoteName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).default('origin'),
    targetBranch: z.string().trim().min(1).max(255).optional(),
  })).optional().default([]),
  repositoryUrls: z.array(z.object({
    url: z.string().trim().min(1).max(2048),
    name: z.string().trim().min(1).max(200).optional(),
  })).max(20).optional().default([]),
}).refine((value) => value.repositories.length > 0 || value.repositoryUrls.length > 0 || true, { message: 'Project creation requires no minimum repositories' });

export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).optional(),
});

export const addRepositorySchema = z.object({
  url: z.string().trim().min(1).max(2048),
  name: z.string().trim().min(1).max(200).optional(),
});

export const attachmentMetadataSchema = z.object({
  id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(0).max(10 * 1024 * 1024),
});

export const createJobSchema = z.object({
  projectId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(100_000),
  scopeMode: z.enum(['auto', 'manual', 'all']).default('auto'),
  requestedRepositoryIds: z.array(z.string().uuid()).optional(),
  selectedRepositoryIds: z.array(z.string().uuid()).optional(),
  agent: z.enum(['mock', 'codex', 'claude']).optional(),
  model: z.string().max(128).optional(),
  reasoningLevel: z.enum(['low', 'medium', 'high']).optional(),
  attachments: z.array(attachmentMetadataSchema).max(10).optional(),
}).superRefine((value, context) => {
  const ids = value.requestedRepositoryIds ?? value.selectedRepositoryIds ?? [];
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'Repository IDs must be unique' });
  }
  if (value.scopeMode === 'manual' && ids.length === 0) context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'Manual scope requires at least one repository' });
  if (value.scopeMode === 'all' && ids.length > 0) context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'All scope does not accept repository selections' });
  const attachments = value.attachments ?? [];
  const totalSize = attachments.reduce((sum, a) => sum + a.sizeBytes, 0);
  if (totalSize > 50 * 1024 * 1024) context.addIssue({ code: 'custom', path: ['attachments'], message: 'Total attachment size exceeds 50MB' });
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
  model: z.string().max(128).optional(),
  reasoningLevel: z.enum(['low', 'medium', 'high']).optional(),
  attachments: z.array(attachmentMetadataSchema).max(10).optional(),
}).superRefine((value, context) => {
  const ids = value.requestedRepositoryIds ?? [];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'Repository IDs must be unique' });
  if (value.scopeMode === 'manual' && ids.length === 0) context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'Manual scope requires at least one repository' });
  if (value.scopeMode !== 'manual' && ids.length > 0) context.addIssue({ code: 'custom', path: ['requestedRepositoryIds'], message: 'Repository selections require manual scope' });
  const attachments = value.attachments ?? [];
  const totalSize = attachments.reduce((sum, a) => sum + a.sizeBytes, 0);
  if (totalSize > 50 * 1024 * 1024) context.addIssue({ code: 'custom', path: ['attachments'], message: 'Total attachment size exceeds 50MB' });
});

export const threadSearchSchema = z.object({
  query: z.string().max(500).optional(),
  projectId: z.string().uuid().optional(),
  status: z.enum(['queued', 'running', 'needs_input', 'failed', 'done', 'cancelled']).optional(),
  agent: z.enum(['mock', 'codex', 'claude']).optional(),
  repositoryId: z.string().uuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  includeArchived: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const promoteJobSchema = z.object({
  commitMessage: z.string().trim().min(1).max(500).refine((value) => !value.includes('\0'), 'Commit message contains an invalid character'),
  approvedRepositoryIds: z.array(z.string().uuid()).min(1).max(100),
}).superRefine((value, context) => {
  if (new Set(value.approvedRepositoryIds).size !== value.approvedRepositoryIds.length)
    context.addIssue({ code: 'custom', path: ['approvedRepositoryIds'], message: 'Repository IDs must be unique' });
});
