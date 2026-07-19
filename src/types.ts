export const JOB_STATUSES = [
  'queued', 'running', 'needs_input', 'failed', 'done', 'cancelled',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

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
  status: JobStatus;
  selectedRepositoryIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface JobEvent {
  id: number;
  jobId: string;
  type: string;
  message: string;
  data: unknown;
  createdAt: string;
}
