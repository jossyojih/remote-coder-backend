export const JOB_STATUSES = [
  'queued', 'running', 'needs_input', 'failed', 'done', 'cancelled',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export const SCOPE_MODES = ['auto', 'manual', 'all'] as const;
export type ScopeMode = (typeof SCOPE_MODES)[number];
export const PROMOTION_POLICIES = ['review_required', 'auto_push', 'read_only'] as const;
export type PromotionPolicy = (typeof PROMOTION_POLICIES)[number];
export type Agent = 'mock' | 'codex' | 'claude';
export type ReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface AgentSelection { agent: Agent; model: string; reasoningLevel?: ReasoningLevel }
export interface ScopeReason { repositoryId: string; reason: string }
export interface ThreadRepositoryPermission {
  repositoryId: string;
  decision: 'approved' | 'rejected';
  inherited: boolean;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  promotionPolicy: PromotionPolicy;
  defaultAgent?: Agent;
  defaultModel?: string;
  defaultReasoningLevel?: ReasoningLevel;
  repositories: Repository[];
}

export interface Repository {
  id: string;
  projectId: string;
  name: string;
  path: string;
  createdAt: string;
  remoteName?: string;
  targetBranch?: string;
  promotionPolicyOverride?: PromotionPolicy;
  effectivePromotionPolicy: PromotionPolicy;
}

export interface Job {
  id: string;
  projectId: string;
  prompt: string;
  agent: Agent;
  model: string;
  reasoningLevel?: ReasoningLevel;
  status: JobStatus;
  scopeMode: ScopeMode;
  requestedRepositoryIds: string[];
  resolvedRepositoryIds: string[];
  scopeReasons: ScopeReason[];
  proposedRepositoryIds?: string[];
  selectedRepositoryIds: string[];
  parentJobId?: string;
  threadId: string;
  conversationContext?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  purgeAfter?: string;
  finalResponse?: string;
  usage?: Record<string, unknown>;
  repositoryResults?: Array<Record<string, unknown>>;
  error?: string;
  question?: string;
  repositoryScopeCandidates?: Array<{ repositoryId: string; repositoryName: string; role: string }>;
  attachmentPaths?: string[];
  threadRepositoryPermissions: ThreadRepositoryPermission[];
}

export interface ArchivedThread {
  threadId: string; projectId: string; title: string; runCount: number;
  archivedAt: string; purgeAfter: string; latestStatus: JobStatus;
}

export type AgentEventEmitter = (type: string, message: string, data?: unknown) => void;

export interface AgentAdapter {
  run(job: Job, repositories: Repository[], emit: AgentEventEmitter, signal: AbortSignal): Promise<void>;
}

export interface JobEvent {
  id: number;
  jobId: string;
  type: string;
  message: string;
  data: unknown;
  createdAt: string;
}

export type PromotionStatus = 'pending' | 'promoting' | 'promoted' | 'failed';
export interface JobRepositoryRun {
  jobId: string; repositoryId: string; worktreePath: string; sourcePath: string;
  branch: string; remoteName: string; remoteUrl: string; targetBranch: string;
  baseCommitSha: string; gitCommonDir: string;
}
export interface PromotionRepositoryResult {
  repositoryId: string; status: PromotionStatus; commitSha?: string;
  targetBranch: string; additions: number; deletions: number; changedFiles: number;
  error?: string; conflict?: boolean; updatedAt: string;
}
export interface Promotion {
  id: string; jobId: string; commitMessage: string; status: PromotionStatus;
  createdAt: string; updatedAt: string; repositories: PromotionRepositoryResult[];
}
export const DEPLOYMENT_STATUSES = ['queued', 'deploying', 'succeeded', 'failed', 'rolled_back'] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];
export interface Deployment {
  id: string; jobId: string; promotionId: string; repositoryId: string; commitSha: string;
  status: DeploymentStatus; stage: string; errorCode?: string; createdAt: string; updatedAt: string;
}
export interface DeploymentClaim extends Deployment {
  sourcePath: string; remoteName: string; targetBranch: string;
}

export interface ThreadSearchFilters {
  query?: string;
  projectId?: string;
  status?: JobStatus;
  agent?: Agent;
  repositoryId?: string;
  dateFrom?: string;
  dateTo?: string;
  includeArchived?: boolean;
  page?: number;
  pageSize?: number;
}

export interface ThreadSearchResult {
  threadId: string;
  projectId: string;
  title: string;
  latestStatus: JobStatus;
  agent: Agent;
  model: string;
  runCount: number;
  repositoryIds: string[];
  updatedAt: string;
  createdAt: string;
  archived: boolean;
}

export interface ThreadSearchResponse {
  results: ThreadSearchResult[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
