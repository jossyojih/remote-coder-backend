import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentSelection, ArchivedThread, Deployment, DeploymentClaim, DeploymentStatus, Job, JobEvent, JobRepositoryRun, JobStatus, Project, Promotion, PromotionPolicy, PromotionStatus, Repository, ScopeMode, ScopeReason } from './types.js';

type ProjectRow = { id: string; name: string; created_at: string; promotion_policy: PromotionPolicy; default_agent: AgentSelection['agent'] | null; default_model: string | null; default_reasoning_level: AgentSelection['reasoningLevel'] | null };
type RepoRow = { id: string; project_id: string; name: string; path: string; remote_name?: string; target_branch?: string | null; promotion_policy_override?: PromotionPolicy | null; created_at: string };
type JobRow = { id: string; project_id: string; prompt: string; agent: AgentSelection['agent']; model: string | null; reasoning_level: AgentSelection['reasoningLevel'] | null; status: JobStatus; scope_mode: ScopeMode; scope_state: string; scope_reasons: string; proposed_repository_ids: string; parent_job_id: string | null; thread_id: string | null; conversation_context: string | null; follow_up_request_id: string | null; created_at: string; updated_at: string; archived_at: string | null; purge_after: string | null };
type EventRow = { id: number; job_id: string; type: string; message: string; data: string; created_at: string };

function objectData(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL, remote_name TEXT NOT NULL DEFAULT 'origin', target_branch TEXT,
        UNIQUE(project_id, path)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','needs_input','failed','done','cancelled')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT 'mock' CHECK(agent IN ('mock','codex','claude'))
      );
      CREATE TABLE IF NOT EXISTS job_repositories (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL REFERENCES repositories(id), PRIMARY KEY(job_id, repository_id)
      );
      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        type TEXT NOT NULL, message TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS events_job_id ON job_events(job_id, id);
      CREATE TABLE IF NOT EXISTS job_repository_runs (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, repository_id TEXT NOT NULL REFERENCES repositories(id),
        worktree_path TEXT NOT NULL, source_path TEXT NOT NULL, branch TEXT NOT NULL, remote_name TEXT NOT NULL,
        remote_url TEXT NOT NULL, target_branch TEXT NOT NULL, base_commit_sha TEXT NOT NULL, git_common_dir TEXT NOT NULL,
        PRIMARY KEY(job_id, repository_id)
      );
      CREATE TABLE IF NOT EXISTS promotions (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
        commit_message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','promoting','promoted','failed')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS promotion_repositories (
        promotion_id TEXT NOT NULL REFERENCES promotions(id) ON DELETE CASCADE, repository_id TEXT NOT NULL REFERENCES repositories(id),
        status TEXT NOT NULL CHECK(status IN ('pending','promoting','promoted','failed')), commit_sha TEXT,
        target_branch TEXT NOT NULL, error TEXT, conflict INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        additions INTEGER, deletions INTEGER, changed_files INTEGER,
        PRIMARY KEY(promotion_id, repository_id)
      );
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        promotion_id TEXT NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL REFERENCES repositories(id), commit_sha TEXT NOT NULL,
        source_path TEXT NOT NULL, remote_name TEXT NOT NULL, target_branch TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','deploying','succeeded','failed','rolled_back')),
        stage TEXT NOT NULL, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(promotion_id, repository_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS deployments_one_active ON deployments((1)) WHERE status IN ('queued','deploying');
    `);
    const repositoryColumns = this.db.prepare('PRAGMA table_info(repositories)').all() as unknown as Array<{ name: string }>;
    if (!repositoryColumns.some((column) => column.name === 'remote_name')) this.db.exec("ALTER TABLE repositories ADD COLUMN remote_name TEXT NOT NULL DEFAULT 'origin'");
    if (!repositoryColumns.some((column) => column.name === 'target_branch')) this.db.exec('ALTER TABLE repositories ADD COLUMN target_branch TEXT');
    if (!repositoryColumns.some((column) => column.name === 'promotion_policy_override')) this.db.exec("ALTER TABLE repositories ADD COLUMN promotion_policy_override TEXT CHECK(promotion_policy_override IN ('review_required','auto_push','read_only'))");
    const projectColumns = this.db.prepare('PRAGMA table_info(projects)').all() as unknown as Array<{ name: string }>;
    if (!projectColumns.some((column) => column.name === 'promotion_policy')) this.db.exec("ALTER TABLE projects ADD COLUMN promotion_policy TEXT NOT NULL DEFAULT 'review_required' CHECK(promotion_policy IN ('review_required','auto_push','read_only'))");
    if (!projectColumns.some((column) => column.name === 'default_agent')) this.db.exec('ALTER TABLE projects ADD COLUMN default_agent TEXT');
    if (!projectColumns.some((column) => column.name === 'default_model')) this.db.exec('ALTER TABLE projects ADD COLUMN default_model TEXT');
    if (!projectColumns.some((column) => column.name === 'default_reasoning_level')) this.db.exec('ALTER TABLE projects ADD COLUMN default_reasoning_level TEXT');
    const promotionRepositoryColumns = this.db.prepare('PRAGMA table_info(promotion_repositories)').all() as unknown as Array<{ name: string }>;
    if (!promotionRepositoryColumns.some((column) => column.name === 'additions')) this.db.exec('ALTER TABLE promotion_repositories ADD COLUMN additions INTEGER');
    if (!promotionRepositoryColumns.some((column) => column.name === 'deletions')) this.db.exec('ALTER TABLE promotion_repositories ADD COLUMN deletions INTEGER');
    if (!promotionRepositoryColumns.some((column) => column.name === 'changed_files')) this.db.exec('ALTER TABLE promotion_repositories ADD COLUMN changed_files INTEGER');
    const jobColumns = this.db.prepare('PRAGMA table_info(jobs)').all() as unknown as Array<{ name: string }>;
    if (!jobColumns.some((column) => column.name === 'agent')) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN agent TEXT NOT NULL DEFAULT 'mock'");
    }
    const jobsSql = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get() as { sql: string }).sql;
    if (jobsSql.includes("agent IN ('mock','codex')")) {
      this.db.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        CREATE TABLE jobs_v2 (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          prompt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','needs_input','failed','done','cancelled')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          agent TEXT NOT NULL DEFAULT 'mock' CHECK(agent IN ('mock','codex','claude'))
        );
        INSERT INTO jobs_v2 SELECT id, project_id, prompt, status, created_at, updated_at, agent FROM jobs;
        DROP TABLE jobs;
        ALTER TABLE jobs_v2 RENAME TO jobs;
        CREATE INDEX jobs_status_created ON jobs(status, created_at);
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    }
    const migratedJobColumns = this.db.prepare('PRAGMA table_info(jobs)').all() as unknown as Array<{ name: string }>;
    if (!migratedJobColumns.some((column) => column.name === 'parent_job_id')) this.db.exec('ALTER TABLE jobs ADD COLUMN parent_job_id TEXT');
    if (!migratedJobColumns.some((column) => column.name === 'thread_id')) this.db.exec('ALTER TABLE jobs ADD COLUMN thread_id TEXT');
    if (!migratedJobColumns.some((column) => column.name === 'conversation_context')) this.db.exec("ALTER TABLE jobs ADD COLUMN conversation_context TEXT NOT NULL DEFAULT ''");
    if (!migratedJobColumns.some((column) => column.name === 'follow_up_request_id')) this.db.exec('ALTER TABLE jobs ADD COLUMN follow_up_request_id TEXT');
    if (!migratedJobColumns.some((column) => column.name === 'scope_mode')) this.db.exec("ALTER TABLE jobs ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'manual'");
    if (!migratedJobColumns.some((column) => column.name === 'scope_state')) this.db.exec("ALTER TABLE jobs ADD COLUMN scope_state TEXT NOT NULL DEFAULT 'resolved'");
    if (!migratedJobColumns.some((column) => column.name === 'scope_reasons')) this.db.exec("ALTER TABLE jobs ADD COLUMN scope_reasons TEXT NOT NULL DEFAULT '[]'");
    if (!migratedJobColumns.some((column) => column.name === 'proposed_repository_ids')) this.db.exec("ALTER TABLE jobs ADD COLUMN proposed_repository_ids TEXT NOT NULL DEFAULT '[]'");
    if (!migratedJobColumns.some((column) => column.name === 'model')) this.db.exec("ALTER TABLE jobs ADD COLUMN model TEXT NOT NULL DEFAULT ''");
    if (!migratedJobColumns.some((column) => column.name === 'reasoning_level')) this.db.exec('ALTER TABLE jobs ADD COLUMN reasoning_level TEXT');
    if (!migratedJobColumns.some((column) => column.name === 'archived_at')) this.db.exec('ALTER TABLE jobs ADD COLUMN archived_at TEXT');
    if (!migratedJobColumns.some((column) => column.name === 'purge_after')) this.db.exec('ALTER TABLE jobs ADD COLUMN purge_after TEXT');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_requested_repositories (job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, repository_id TEXT NOT NULL REFERENCES repositories(id), PRIMARY KEY(job_id,repository_id));
      INSERT OR IGNORE INTO job_requested_repositories SELECT job_id, repository_id FROM job_repositories;
    `);
    this.db.exec(`
      UPDATE jobs SET thread_id = id WHERE thread_id IS NULL OR thread_id = '';
      CREATE INDEX IF NOT EXISTS jobs_thread_created ON jobs(thread_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_follow_up_request ON jobs(parent_job_id, follow_up_request_id) WHERE follow_up_request_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS jobs_archive_purge ON jobs(archived_at, purge_after);
    `);
    // A process that died mid-job leaves work recoverable.
    this.db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(new Date().toISOString());
  }

  close() { this.db.close(); }

  normalizeLegacySelections(defaults: { codexModel: string; codexReasoning: string; claudeModel: string }): void {
    this.db.prepare("UPDATE jobs SET model=? WHERE agent='codex' AND (model IS NULL OR model='')").run(defaults.codexModel);
    this.db.prepare("UPDATE jobs SET reasoning_level=? WHERE agent='codex' AND reasoning_level IS NULL").run(defaults.codexReasoning);
    this.db.prepare("UPDATE jobs SET model=? WHERE agent='claude' AND (model IS NULL OR model='')").run(defaults.claudeModel);
    this.db.prepare("UPDATE jobs SET model='mock' WHERE agent='mock' AND (model IS NULL OR model='')").run();
  }

  createProject(name: string, repositories: Array<{ name: string; path: string; remoteName?: string; targetBranch?: string }>): Project {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO projects(id,name,created_at,promotion_policy) VALUES (?, ?, ?, ?)').run(id, name, now, 'review_required');
      const insert = this.db.prepare('INSERT INTO repositories(id,project_id,name,path,created_at,remote_name,target_branch) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const repo of repositories) insert.run(crypto.randomUUID(), id, repo.name, repo.path, now, repo.remoteName ?? 'origin', repo.targetBranch ?? null);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getProject(id)!;
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as unknown as ProjectRow[];
    return rows.map((row) => this.mapProject(row));
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined;
    return row ? this.mapProject(row) : undefined;
  }

  private mapProject(row: ProjectRow): Project {
    const repos = this.db.prepare('SELECT * FROM repositories WHERE project_id = ? ORDER BY created_at, name').all(row.id) as unknown as RepoRow[];
    return { id: row.id, name: row.name, createdAt: row.created_at, promotionPolicy: row.promotion_policy ?? 'review_required', defaultAgent: row.default_agent ?? undefined, defaultModel: row.default_model ?? undefined, defaultReasoningLevel: row.default_reasoning_level ?? undefined, repositories: repos.map((repo) => this.mapRepo(repo, row.promotion_policy ?? 'review_required')) };
  }

  private mapRepo = (row: RepoRow, projectPolicy?: PromotionPolicy): Repository => {
    const fallback = projectPolicy ?? (this.db.prepare('SELECT promotion_policy FROM projects WHERE id=?').get(row.project_id) as { promotion_policy: PromotionPolicy } | undefined)?.promotion_policy ?? 'review_required';
    return { id: row.id, projectId: row.project_id, name: row.name, path: row.path, createdAt: row.created_at, remoteName: row.remote_name ?? 'origin', targetBranch: row.target_branch ?? undefined, promotionPolicyOverride: row.promotion_policy_override ?? undefined, effectivePromotionPolicy: row.promotion_policy_override ?? fallback };
  };

  updateProjectPromotionPolicy(id: string, policy: PromotionPolicy): Project | undefined {
    const result = this.db.prepare('UPDATE projects SET promotion_policy=? WHERE id=?').run(policy, id);
    return Number(result.changes) ? this.getProject(id) : undefined;
  }

  updateProjectAgentDefaults(id: string, selection: AgentSelection): Project | undefined {
    const result = this.db.prepare('UPDATE projects SET default_agent=?, default_model=?, default_reasoning_level=? WHERE id=?').run(selection.agent, selection.model, selection.reasoningLevel ?? null, id);
    return Number(result.changes) ? this.getProject(id) : undefined;
  }

  updateRepositoryPromotionPolicy(projectId: string, repositoryId: string, policy: PromotionPolicy | null): Project | undefined {
    const result = this.db.prepare('UPDATE repositories SET promotion_policy_override=? WHERE id=? AND project_id=?').run(policy, repositoryId, projectId);
    return Number(result.changes) ? this.getProject(projectId) : undefined;
  }

  repositoriesBelongTo(projectId: string, ids: string[]): boolean {
    const placeholders = ids.map(() => '?').join(',');
    if (!placeholders) return false;
    const row = this.db.prepare(`SELECT COUNT(*) count FROM repositories WHERE project_id = ? AND id IN (${placeholders})`).get(projectId, ...ids) as { count: number };
    return Number(row.count) === ids.length;
  }

  repositories(ids: string[]): Repository[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM repositories WHERE id IN (${placeholders})`).all(...ids) as unknown as RepoRow[];
    const byId = new Map(rows.map((row) => [row.id, this.mapRepo(row)]));
    return ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  }

  createJob(projectId: string, prompt: string, repositoryIds: string[], requestedSelection: AgentSelection | AgentSelection['agent'], scopeMode: ScopeMode): Job {
    const selection: AgentSelection = typeof requestedSelection === 'string'
      ? { agent: requestedSelection, model: requestedSelection === 'claude' ? 'sonnet' : requestedSelection === 'mock' ? 'mock' : 'gpt-5-codex', ...(requestedSelection === 'codex' ? { reasoningLevel: 'medium' as const } : {}) }
      : requestedSelection;
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO jobs(id,project_id,prompt,status,created_at,updated_at,agent,model,reasoning_level,thread_id,scope_mode,scope_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, prompt, 'queued', now, now, selection.agent, selection.model, selection.reasoningLevel ?? null, id, scopeMode, 'pending');
      const insert = this.db.prepare('INSERT INTO job_requested_repositories VALUES (?, ?)');
      for (const repositoryId of repositoryIds) insert.run(id, repositoryId);
      this.addEvent(id, 'status', 'Job queued', { status: 'queued' });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getJob(id)!;
  }

  getJob(id: string, includeArchived = false): Job | undefined {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'}`).get(id) as unknown as JobRow | undefined;
    return row ? this.mapJob(row) : undefined;
  }

  listJobs(projectId?: string): Job[] {
    const rows = (projectId
      ? this.db.prepare('SELECT * FROM jobs WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at DESC').all(projectId)
      : this.db.prepare('SELECT * FROM jobs WHERE archived_at IS NULL ORDER BY created_at DESC').all()) as unknown as JobRow[];
    return rows.map((row) => this.mapJob(row));
  }

  private mapJob(row: JobRow): Job {
    const selected = this.db.prepare('SELECT repository_id FROM job_repositories WHERE job_id = ? ORDER BY rowid').all(row.id) as unknown as Array<{ repository_id: string }>;
    const events = this.events(row.id);
    const finalResponse = events.filter((event) => event.type === 'final_response').at(-1)?.message;
    const usage = objectData(events.filter((event) => event.type === 'token_usage').at(-1)?.data);
    const repositoryResults = events.filter((event) => event.type === 'repository_result').flatMap((event) => {
      const data = objectData(event.data); return data ? [data] : [];
    });
    const errorEvent = events.filter((event) => event.type === 'error').at(-1);
    const errorData = objectData(errorEvent?.data);
    const error = errorEvent ? (typeof errorData?.error === 'string' ? errorData.error : errorEvent.message) : undefined;
    const questionEvent = events.filter((event) => {
      const data = objectData(event.data);
      return event.type === 'question' || event.type === 'needs_input' || typeof data?.question === 'string' || data?.status === 'needs_input';
    }).at(-1);
    const questionData = objectData(questionEvent?.data);
    const question = questionEvent ? (typeof questionData?.question === 'string' ? questionData.question : questionEvent.message) : undefined;
    const requested = this.db.prepare('SELECT repository_id FROM job_requested_repositories WHERE job_id = ? ORDER BY rowid').all(row.id) as unknown as Array<{ repository_id: string }>;
    const reasons = JSON.parse(row.scope_reasons ?? '[]') as ScopeReason[];
    const proposed = JSON.parse(row.proposed_repository_ids ?? '[]') as string[];
    const job: Job = {
      id: row.id, projectId: row.project_id, prompt: row.prompt, agent: row.agent ?? 'mock', model: row.model || (row.agent === 'claude' ? 'sonnet' : row.agent === 'mock' ? 'mock' : 'gpt-5-codex'), reasoningLevel: row.reasoning_level ?? undefined, status: row.status,
      scopeMode: row.scope_mode ?? 'manual', requestedRepositoryIds: requested.map((x) => x.repository_id), resolvedRepositoryIds: selected.map((x) => x.repository_id), scopeReasons: reasons,
      proposedRepositoryIds: proposed.length ? proposed : undefined,
      selectedRepositoryIds: selected.length ? selected.map((x) => x.repository_id) : requested.map((x) => x.repository_id), parentJobId: row.parent_job_id ?? undefined,
      threadId: row.thread_id ?? row.id,
      createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at ?? undefined, purgeAfter: row.purge_after ?? undefined, finalResponse, usage,
      repositoryResults: repositoryResults.length ? repositoryResults : undefined, error, question,
    };
    if (row.conversation_context) Object.defineProperty(job, 'conversationContext', { value: row.conversation_context, enumerable: false });
    return job;
  }

  scopeState(id: string): string | undefined { return (this.db.prepare('SELECT scope_state FROM jobs WHERE id = ?').get(id) as { scope_state: string } | undefined)?.scope_state; }

  resolveScope(id: string, repositoryIds: string[], reasons: ScopeReason[], state = 'resolved'): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM job_repositories WHERE job_id = ?').run(id);
      const insert = this.db.prepare('INSERT INTO job_repositories VALUES (?, ?)');
      for (const repositoryId of repositoryIds) insert.run(id, repositoryId);
      this.db.prepare('UPDATE jobs SET scope_state = ?, scope_reasons = ?, proposed_repository_ids = ?, updated_at = ? WHERE id = ?').run(state, JSON.stringify(reasons), '[]', new Date().toISOString(), id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  proposeScope(id: string, repositoryIds: string[], reasons: ScopeReason[], state = 'awaiting_decision'): void {
    this.db.prepare("UPDATE jobs SET scope_state = ?, scope_reasons = ?, proposed_repository_ids = ?, status = 'needs_input', updated_at = ? WHERE id = ?")
      .run(state, JSON.stringify(reasons), JSON.stringify(repositoryIds), new Date().toISOString(), id);
  }

  decideScope(id: string, approve: boolean, chosenRepositoryIds?: string[]): Job | undefined {
    const state = this.scopeState(id); const job = this.getJob(id); if (!job || job.status !== 'needs_input' || !['awaiting_decision', 'awaiting_correction'].includes(state ?? '')) return undefined;
    if (chosenRepositoryIds && !this.repositoriesBelongTo(job.projectId, chosenRepositoryIds)) return undefined;
    const resolved = chosenRepositoryIds ?? (approve ? (state === 'awaiting_correction' ? (job.proposedRepositoryIds ?? []) : [...new Set([...job.requestedRepositoryIds, ...(job.proposedRepositoryIds ?? [])])]) : job.requestedRepositoryIds);
    const reasons = job.scopeReasons.filter((reason) => resolved.includes(reason.repositoryId));
    this.resolveScope(id, resolved, reasons, 'resolved'); this.setStatus(id, 'queued'); return this.getJob(id);
  }

  conversation(jobId: string): Job[] | undefined {
    const job = this.getJob(jobId); if (!job) return undefined;
    const rows = this.db.prepare('SELECT * FROM jobs WHERE thread_id = ? ORDER BY created_at, rowid').all(job.threadId) as unknown as JobRow[];
    return rows.map((row) => this.mapJob(row));
  }

  archivedThreads(now = new Date().toISOString()): ArchivedThread[] {
    const rows = this.db.prepare(`SELECT thread_id, project_id,
      (SELECT prompt FROM jobs first WHERE first.thread_id=jobs.thread_id ORDER BY created_at,rowid LIMIT 1) title,
      COUNT(*) run_count, MIN(archived_at) archived_at, MIN(purge_after) purge_after,
      (SELECT status FROM jobs latest WHERE latest.thread_id=jobs.thread_id ORDER BY created_at DESC,rowid DESC LIMIT 1) latest_status
      FROM jobs WHERE archived_at IS NOT NULL AND purge_after > ? GROUP BY thread_id, project_id ORDER BY archived_at DESC`).all(now) as unknown as Array<{ thread_id: string; project_id: string; title: string; run_count: number; archived_at: string; purge_after: string; latest_status: JobStatus }>;
    return rows.map((row) => ({ threadId: row.thread_id, projectId: row.project_id, title: row.title, runCount: Number(row.run_count), archivedAt: row.archived_at, purgeAfter: row.purge_after, latestStatus: row.latest_status }));
  }

  threadActiveJobIds(jobId: string): string[] | undefined {
    const row = this.db.prepare('SELECT thread_id FROM jobs WHERE id=?').get(jobId) as { thread_id: string } | undefined;
    if (!row) return undefined;
    return (this.db.prepare("SELECT id FROM jobs WHERE thread_id=? AND archived_at IS NULL AND status IN ('queued','running','needs_input')").all(row.thread_id) as Array<{ id: string }>).map((item) => item.id);
  }

  archiveThread(jobId: string, nowMs = Date.now()): { thread?: ArchivedThread; conflict?: string } {
    const row = this.db.prepare('SELECT thread_id FROM jobs WHERE id=?').get(jobId) as { thread_id: string } | undefined;
    if (!row) return { conflict: 'not_found' };
    const existing = this.db.prepare('SELECT 1 FROM jobs WHERE thread_id=? AND archived_at IS NOT NULL LIMIT 1').get(row.thread_id);
    if (!existing) {
      if ((this.threadActiveJobIds(jobId) ?? []).length) return { conflict: 'active' };
      const archivedAt = new Date(nowMs).toISOString();
      const purgeAfter = new Date(nowMs + 7 * 86_400_000).toISOString();
      this.db.prepare('UPDATE jobs SET archived_at=?,purge_after=? WHERE thread_id=?').run(archivedAt, purgeAfter, row.thread_id);
    }
    return { thread: this.archivedThreads(new Date(nowMs - 1).toISOString()).find((thread) => thread.threadId === row.thread_id) };
  }

  restoreThread(jobId: string, nowMs = Date.now()): { threadId?: string; conflict?: string } {
    const row = this.db.prepare('SELECT thread_id,purge_after FROM jobs WHERE id=?').get(jobId) as { thread_id: string; purge_after: string | null } | undefined;
    if (!row) return { conflict: 'not_found' };
    if (!row.purge_after) return { threadId: row.thread_id };
    if (row.purge_after <= new Date(nowMs).toISOString()) return { conflict: 'expired' };
    this.db.prepare('UPDATE jobs SET archived_at=NULL,purge_after=NULL WHERE thread_id=?').run(row.thread_id);
    return { threadId: row.thread_id };
  }

  expiredThreadRuns(nowMs = Date.now()): Array<{ threadId: string; runs: JobRepositoryRun[] }> {
    const threads = this.db.prepare('SELECT DISTINCT thread_id FROM jobs WHERE archived_at IS NOT NULL AND purge_after <= ?').all(new Date(nowMs).toISOString()) as Array<{ thread_id: string }>;
    return threads.map(({ thread_id }) => ({ threadId: thread_id, runs: (this.db.prepare('SELECT r.* FROM job_repository_runs r JOIN jobs j ON j.id=r.job_id WHERE j.thread_id=?').all(thread_id) as any[]).map((r) => ({ jobId: r.job_id, repositoryId: r.repository_id, worktreePath: r.worktree_path, sourcePath: r.source_path, branch: r.branch, remoteName: r.remote_name, remoteUrl: r.remote_url, targetBranch: r.target_branch, baseCommitSha: r.base_commit_sha, gitCommonDir: r.git_common_dir })) }));
  }

  purgeExpiredThread(threadId: string, nowMs = Date.now()): boolean {
    const ids = (this.db.prepare('SELECT id FROM jobs WHERE thread_id=? AND archived_at IS NOT NULL AND purge_after <= ?').all(threadId, new Date(nowMs).toISOString()) as Array<{ id: string }>).map((row) => row.id);
    if (!ids.length) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) {
        this.db.prepare('DELETE FROM job_events WHERE job_id=?').run(id);
        this.db.prepare('DELETE FROM job_repository_runs WHERE job_id=?').run(id);
        this.db.prepare('DELETE FROM job_repositories WHERE job_id=?').run(id);
        this.db.prepare('DELETE FROM job_requested_repositories WHERE job_id=?').run(id);
        if (this.db.prepare('SELECT 1 FROM promotions WHERE job_id=?').get(id)) this.db.prepare("UPDATE jobs SET prompt='[purged archived thread]',conversation_context='',follow_up_request_id=NULL,purge_after=NULL WHERE id=?").run(id);
        else this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
      }
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  createFollowUp(parentId: string, message: string, requestId: string, scopeMode?: ScopeMode, requestedRepositoryIds?: string[], selection?: AgentSelection): { job?: Job; conflict?: string } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const parentRow = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(parentId) as unknown as JobRow | undefined;
      if (!parentRow) { this.db.exec('ROLLBACK'); return { conflict: 'not_found' }; }
      if (parentRow.archived_at) { this.db.exec('ROLLBACK'); return { conflict: 'archived' }; }
      const duplicate = this.db.prepare('SELECT * FROM jobs WHERE parent_job_id = ? AND follow_up_request_id = ?').get(parentId, requestId) as unknown as JobRow | undefined;
      if (duplicate) { this.db.exec('COMMIT'); return { job: this.mapJob(duplicate) }; }
      if (!['done', 'failed', 'cancelled'].includes(parentRow.status)) { this.db.exec('ROLLBACK'); return { conflict: 'parent_active' }; }
      const threadId = parentRow.thread_id ?? parentRow.id;
      const latest = this.db.prepare('SELECT id FROM jobs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(threadId) as { id: string };
      if (latest.id !== parentId) { this.db.exec('ROLLBACK'); return { conflict: 'not_latest' }; }
      const active = this.db.prepare("SELECT id FROM jobs WHERE thread_id = ? AND status IN ('queued','running','needs_input') LIMIT 1").get(threadId);
      if (active) { this.db.exec('ROLLBACK'); return { conflict: 'thread_active' }; }
      const inheritedRepositoryIds = (this.db.prepare('SELECT repository_id FROM job_repositories WHERE job_id = ? ORDER BY rowid').all(parentId) as unknown as Array<{ repository_id: string }>).map((row) => row.repository_id);
      const repositoryIds = scopeMode === 'manual' ? requestedRepositoryIds! : inheritedRepositoryIds;
      if (!this.repositoriesBelongTo(parentRow.project_id, repositoryIds)) { this.db.exec('ROLLBACK'); return { conflict: 'scope_invalid' }; }
      const id = crypto.randomUUID(); const now = new Date().toISOString();
      const context = this.buildConversationContext(threadId);
      const effectiveMode = scopeMode ?? parentRow.scope_mode;
      const replan = scopeMode === 'auto' || scopeMode === 'all';
      const effectiveSelection = selection ?? { agent: parentRow.agent, model: parentRow.model || (parentRow.agent === 'claude' ? 'sonnet' : 'gpt-5-codex'), reasoningLevel: parentRow.reasoning_level ?? undefined };
      this.db.prepare(`INSERT INTO jobs(id,project_id,prompt,status,created_at,updated_at,agent,model,reasoning_level,parent_job_id,thread_id,conversation_context,follow_up_request_id,scope_mode,scope_state,scope_reasons)
        VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, parentRow.project_id, message, now, now, effectiveSelection.agent, effectiveSelection.model, effectiveSelection.reasoningLevel ?? null, parentId, threadId, context, requestId, effectiveMode, replan ? 'pending' : 'resolved', replan ? '[]' : parentRow.scope_reasons);
      const insert = this.db.prepare('INSERT INTO job_repositories VALUES (?, ?)');
      if (!replan) for (const repositoryId of repositoryIds) insert.run(id, repositoryId);
      const insertRequested = this.db.prepare('INSERT INTO job_requested_repositories VALUES (?, ?)');
      if (!replan) for (const repositoryId of repositoryIds) insertRequested.run(id, repositoryId);
      this.addEvent(id, 'status', 'Follow-up queued', { status: 'queued', parentJobId: parentId, threadId });
      this.db.exec('COMMIT'); return { job: this.getJob(id)! };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private buildConversationContext(threadId: string): string {
    const rows = this.db.prepare('SELECT * FROM jobs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 8').all(threadId) as unknown as JobRow[];
    const turns = rows.reverse().map((row) => {
      const job = this.mapJob(row);
      const outcome = job.finalResponse ?? job.error ?? (job.question ? `Question: ${job.question}` : `Run ended with status ${job.status}.`);
      return `User request:\n${job.prompt.slice(-8_000)}\n\nAgent outcome:\n${outcome.slice(-8_000)}`;
    });
    const context = turns.join('\n\n---\n\n');
    return context.length <= 24_000 ? context : context.slice(context.length - 24_000);
  }

  nextQueuedJob(): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' AND archived_at IS NULL ORDER BY created_at LIMIT 1").get() as unknown as JobRow | undefined;
    return row ? this.mapJob(row) : undefined;
  }

  setStatus(id: string, status: JobStatus): boolean {
    const result = this.db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    return Number(result.changes) > 0;
  }

  claim(id: string): boolean {
    const result = this.db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued' AND archived_at IS NULL").run(new Date().toISOString(), id);
    return Number(result.changes) === 1;
  }

  addEvent(jobId: string, type: string, message: string, data: unknown = {}): JobEvent {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO job_events(job_id,type,message,data,created_at) VALUES(?,?,?,?,?)').run(jobId, type, message, JSON.stringify(data), createdAt);
    return { id: Number(result.lastInsertRowid), jobId, type, message, data, createdAt };
  }

  events(id: string, after = 0): JobEvent[] {
    const rows = this.db.prepare('SELECT * FROM job_events WHERE job_id = ? AND id > ? ORDER BY id').all(id, after) as unknown as EventRow[];
    return rows.map((row) => ({ id: row.id, jobId: row.job_id, type: row.type, message: row.message, data: JSON.parse(row.data), createdAt: row.created_at }));
  }

  recordRepositoryRun(run: JobRepositoryRun): void {
    this.db.prepare(`INSERT OR REPLACE INTO job_repository_runs
      (job_id,repository_id,worktree_path,source_path,branch,remote_name,remote_url,target_branch,base_commit_sha,git_common_dir)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(run.jobId, run.repositoryId, run.worktreePath, run.sourcePath, run.branch, run.remoteName, run.remoteUrl, run.targetBranch, run.baseCommitSha, run.gitCommonDir);
  }

  repositoryRuns(jobId: string): JobRepositoryRun[] {
    type RunRow = { job_id: string; repository_id: string; worktree_path: string; source_path: string; branch: string; remote_name: string; remote_url: string; target_branch: string; base_commit_sha: string; git_common_dir: string };
    const rows = this.db.prepare('SELECT * FROM job_repository_runs WHERE job_id = ? ORDER BY rowid').all(jobId) as unknown as RunRow[];
    return rows.map((r) => ({ jobId: r.job_id, repositoryId: r.repository_id, worktreePath: r.worktree_path, sourcePath: r.source_path, branch: r.branch, remoteName: r.remote_name, remoteUrl: r.remote_url, targetBranch: r.target_branch, baseCommitSha: r.base_commit_sha, gitCommonDir: r.git_common_dir }));
  }

  getPromotion(jobId: string): Promotion | undefined {
    const row = this.db.prepare('SELECT * FROM promotions WHERE job_id = ?').get(jobId) as unknown as { id: string; job_id: string; commit_message: string; status: string; created_at: string; updated_at: string } | undefined;
    if (!row) return undefined;
    const repos = this.db.prepare('SELECT * FROM promotion_repositories WHERE promotion_id = ? ORDER BY rowid').all(row.id) as Array<Record<string, string | number | null>>;
    return { id: row.id, jobId: row.job_id, commitMessage: row.commit_message, status: row.status as PromotionStatus, createdAt: row.created_at, updatedAt: row.updated_at,
      repositories: repos.map((r) => ({ repositoryId: String(r.repository_id), status: r.status as PromotionStatus, commitSha: r.commit_sha ? String(r.commit_sha) : undefined, targetBranch: String(r.target_branch), additions: Number(r.additions ?? 0), deletions: Number(r.deletions ?? 0), changedFiles: Number(r.changed_files ?? 0), error: r.error ? String(r.error) : undefined, conflict: Boolean(r.conflict), updatedAt: String(r.updated_at) })) };
  }

  beginPromotion(jobId: string, message: string, runs: JobRepositoryRun[]): { promotion?: Promotion; conflict?: string } {
    const existing = this.getPromotion(jobId);
    if (existing) {
      const now = new Date().toISOString();
      const insert = this.db.prepare("INSERT OR IGNORE INTO promotion_repositories(promotion_id,repository_id,status,target_branch,updated_at) VALUES (?,?,'pending',?,?)");
      for (const run of runs) insert.run(existing.id, run.repositoryId, run.targetBranch, now);
      return { promotion: this.getPromotion(jobId)! };
    }
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO promotions VALUES (?, ?, ?, 'pending', ?, ?)").run(id, jobId, message, now, now);
      const insert = this.db.prepare("INSERT INTO promotion_repositories(promotion_id,repository_id,status,target_branch,updated_at) VALUES (?,?,'pending',?,?)");
      for (const run of runs) insert.run(id, run.repositoryId, run.targetBranch, now);
      this.db.exec('COMMIT'); return { promotion: this.getPromotion(jobId)! };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  setPromotionRepository(jobId: string, repositoryId: string, status: PromotionStatus, result: { commitSha?: string; error?: string; conflict?: boolean } = {}): void {
    const promotion = this.getPromotion(jobId); if (!promotion) throw new Error('Promotion not found'); const now = new Date().toISOString();
    this.db.prepare('UPDATE promotion_repositories SET status=?,commit_sha=COALESCE(?,commit_sha),error=?,conflict=?,updated_at=? WHERE promotion_id=? AND repository_id=?')
      .run(status, result.commitSha ?? null, result.error ?? null, result.conflict ? 1 : 0, now, promotion.id, repositoryId);
    const states = this.db.prepare('SELECT status FROM promotion_repositories WHERE promotion_id=?').all(promotion.id) as Array<{ status: PromotionStatus }>;
    const aggregate: PromotionStatus = states.every((r) => r.status === 'promoted') ? 'promoted' : states.some((r) => r.status === 'promoting') ? 'promoting' : states.some((r) => r.status === 'failed') ? 'failed' : 'pending';
    this.db.prepare('UPDATE promotions SET status=?,updated_at=? WHERE id=?').run(aggregate, now, promotion.id);
  }

  setPromotionRepositoryStats(jobId: string, repositoryId: string, stats: { additions: number; deletions: number; changedFiles: number }): void {
    const promotion = this.getPromotion(jobId); if (!promotion) throw new Error('Promotion not found');
    this.db.prepare('UPDATE promotion_repositories SET additions=?,deletions=?,changed_files=? WHERE promotion_id=? AND repository_id=?')
      .run(stats.additions, stats.deletions, stats.changedFiles, promotion.id, repositoryId);
  }

  createDeployment(jobId: string, repositoryId: string, commitSha: string, run: JobRepositoryRun): { deployment?: Deployment; conflict?: string } {
    const promotion = this.getPromotion(jobId); if (!promotion) return { conflict: 'promotion_not_found' };
    const existing = this.db.prepare('SELECT id FROM deployments WHERE promotion_id=? AND repository_id=?').get(promotion.id, repositoryId) as { id: string } | undefined;
    if (existing) return { deployment: this.getDeployment(existing.id) };
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    try {
      this.db.prepare("INSERT INTO deployments VALUES (?,?,?,?,?,?,?,?,'queued','queued',NULL,?,?)")
        .run(id, jobId, promotion.id, repositoryId, commitSha, run.sourcePath, run.remoteName, run.targetBranch, now, now);
      return { deployment: this.getDeployment(id)! };
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) return { conflict: 'deployment_active' };
      throw error;
    }
  }

  private mapDeployment(row: Record<string, string | null>): Deployment {
    return { id: row.id!, jobId: row.job_id!, promotionId: row.promotion_id!, repositoryId: row.repository_id!, commitSha: row.commit_sha!, status: row.status as DeploymentStatus, stage: row.stage!, errorCode: row.error_code ?? undefined, createdAt: row.created_at!, updatedAt: row.updated_at! };
  }

  getDeployment(id: string): Deployment | undefined {
    const row = this.db.prepare('SELECT * FROM deployments WHERE id=?').get(id) as Record<string, string | null> | undefined;
    return row ? this.mapDeployment(row) : undefined;
  }

  hasActiveDeployment(): boolean {
    return Boolean(this.db.prepare("SELECT 1 present FROM deployments WHERE status IN ('queued','deploying') LIMIT 1").get());
  }

  deploymentsForJob(jobId: string): Deployment[] {
    const rows = this.db.prepare('SELECT * FROM deployments WHERE job_id=? ORDER BY created_at,rowid').all(jobId) as Array<Record<string, string | null>>;
    return rows.map((row) => this.mapDeployment(row));
  }

  claimDeployment(id: string): DeploymentClaim | undefined {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE deployments SET status='deploying',stage='preparing',updated_at=? WHERE id=? AND status='queued'").run(now, id);
    if (Number(result.changes) !== 1) return undefined;
    const row = this.db.prepare('SELECT * FROM deployments WHERE id=?').get(id) as Record<string, string | null>;
    return { ...this.mapDeployment(row), sourcePath: row.source_path!, remoteName: row.remote_name!, targetBranch: row.target_branch! };
  }

  updateDeployment(id: string, status: DeploymentStatus, stage: string, errorCode?: string): Deployment | undefined {
    const current = this.getDeployment(id); if (!current || !['queued', 'deploying'].includes(current.status)) return undefined;
    this.db.prepare('UPDATE deployments SET status=?,stage=?,error_code=?,updated_at=? WHERE id=?').run(status, stage, errorCode ?? null, new Date().toISOString(), id);
    return this.getDeployment(id);
  }
}
