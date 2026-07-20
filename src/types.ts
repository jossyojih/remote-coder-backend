export const JOB_STATUSES = [
  'queued', 'running', 'needs_input', 'failed', 'done', 'cancelled',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export const SCOPE_MODES = ['auto', 'manual', 'all'] as const;
export type ScopeMode = (typeof SCOPE_MODES)[number];
export interface ScopeReason { repositoryId: string; reason: string }

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  repositories: Repository[];
}

export interface Repository {
  id: string;
  projectId: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface Job {
  id: string;
  projectId: string;
  prompt: string;
  agent: 'mock' | 'codex' | 'claude';
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
  finalResponse?: string;
  usage?: Record<string, unknown>;
  repositoryResults?: Array<Record<string, unknown>>;
  error?: string;
  question?: string;
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
