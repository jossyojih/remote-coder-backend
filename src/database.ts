import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Job, JobEvent, JobStatus, Project, Repository, ScopeMode, ScopeReason } from './types.js';

type ProjectRow = { id: string; name: string; created_at: string };
type RepoRow = { id: string; project_id: string; name: string; path: string; created_at: string };
type JobRow = { id: string; project_id: string; prompt: string; agent: 'mock' | 'codex' | 'claude'; status: JobStatus; scope_mode: ScopeMode; scope_state: string; scope_reasons: string; proposed_repository_ids: string; parent_job_id: string | null; thread_id: string | null; conversation_context: string | null; follow_up_request_id: string | null; created_at: string; updated_at: string };
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
        name TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL,
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
    `);
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_requested_repositories (job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, repository_id TEXT NOT NULL REFERENCES repositories(id), PRIMARY KEY(job_id,repository_id));
      INSERT OR IGNORE INTO job_requested_repositories SELECT job_id, repository_id FROM job_repositories;
    `);
    this.db.exec(`
      UPDATE jobs SET thread_id = id WHERE thread_id IS NULL OR thread_id = '';
      CREATE INDEX IF NOT EXISTS jobs_thread_created ON jobs(thread_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_follow_up_request ON jobs(parent_job_id, follow_up_request_id) WHERE follow_up_request_id IS NOT NULL;
    `);
    // A process that died mid-job leaves work recoverable.
    this.db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(new Date().toISOString());
  }

  close() { this.db.close(); }

  createProject(name: string, repositories: Array<{ name: string; path: string }>): Project {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(id, name, now);
      const insert = this.db.prepare('INSERT INTO repositories VALUES (?, ?, ?, ?, ?)');
      for (const repo of repositories) insert.run(crypto.randomUUID(), id, repo.name, repo.path, now);
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
    return { id: row.id, name: row.name, createdAt: row.created_at, repositories: repos.map(this.mapRepo) };
  }

  private mapRepo = (row: RepoRow): Repository => ({ id: row.id, projectId: row.project_id, name: row.name, path: row.path, createdAt: row.created_at });

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

  createJob(projectId: string, prompt: string, repositoryIds: string[], agent: 'mock' | 'codex' | 'claude', scopeMode: ScopeMode): Job {
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO jobs(id,project_id,prompt,status,created_at,updated_at,agent,thread_id,scope_mode,scope_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, prompt, 'queued', now, now, agent, id, scopeMode, 'pending');
      const insert = this.db.prepare('INSERT INTO job_requested_repositories VALUES (?, ?)');
      for (const repositoryId of repositoryIds) insert.run(id, repositoryId);
      this.addEvent(id, 'status', 'Job queued', { status: 'queued' });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getJob(id)!;
  }

  getJob(id: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
    return row ? this.mapJob(row) : undefined;
  }

  listJobs(projectId?: string): Job[] {
    const rows = (projectId
      ? this.db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all()) as unknown as JobRow[];
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
      id: row.id, projectId: row.project_id, prompt: row.prompt, agent: row.agent ?? 'mock', status: row.status,
      scopeMode: row.scope_mode ?? 'manual', requestedRepositoryIds: requested.map((x) => x.repository_id), resolvedRepositoryIds: selected.map((x) => x.repository_id), scopeReasons: reasons,
      proposedRepositoryIds: proposed.length ? proposed : undefined,
      selectedRepositoryIds: selected.length ? selected.map((x) => x.repository_id) : requested.map((x) => x.repository_id), parentJobId: row.parent_job_id ?? undefined,
      threadId: row.thread_id ?? row.id,
      createdAt: row.created_at, updatedAt: row.updated_at, finalResponse, usage,
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

  proposeScope(id: string, repositoryIds: string[], reasons: ScopeReason[]): void {
    this.db.prepare("UPDATE jobs SET scope_state = 'awaiting_decision', scope_reasons = ?, proposed_repository_ids = ?, status = 'needs_input', updated_at = ? WHERE id = ?")
      .run(JSON.stringify(reasons), JSON.stringify(repositoryIds), new Date().toISOString(), id);
  }

  decideScope(id: string, approve: boolean): Job | undefined {
    const job = this.getJob(id); if (!job || job.status !== 'needs_input' || this.scopeState(id) !== 'awaiting_decision') return undefined;
    const resolved = approve ? [...new Set([...job.requestedRepositoryIds, ...(job.proposedRepositoryIds ?? [])])] : job.requestedRepositoryIds;
    const reasons = job.scopeReasons.filter((reason) => resolved.includes(reason.repositoryId));
    this.resolveScope(id, resolved, reasons, 'resolved'); this.setStatus(id, 'queued'); return this.getJob(id);
  }

  conversation(jobId: string): Job[] | undefined {
    const job = this.getJob(jobId); if (!job) return undefined;
    const rows = this.db.prepare('SELECT * FROM jobs WHERE thread_id = ? ORDER BY created_at, rowid').all(job.threadId) as unknown as JobRow[];
    return rows.map((row) => this.mapJob(row));
  }

  createFollowUp(parentId: string, message: string, requestId: string): { job?: Job; conflict?: string } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const parentRow = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(parentId) as unknown as JobRow | undefined;
      if (!parentRow) { this.db.exec('ROLLBACK'); return { conflict: 'not_found' }; }
      const duplicate = this.db.prepare('SELECT * FROM jobs WHERE parent_job_id = ? AND follow_up_request_id = ?').get(parentId, requestId) as unknown as JobRow | undefined;
      if (duplicate) { this.db.exec('COMMIT'); return { job: this.mapJob(duplicate) }; }
      if (!['done', 'failed', 'cancelled'].includes(parentRow.status)) { this.db.exec('ROLLBACK'); return { conflict: 'parent_active' }; }
      const threadId = parentRow.thread_id ?? parentRow.id;
      const latest = this.db.prepare('SELECT id FROM jobs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(threadId) as { id: string };
      if (latest.id !== parentId) { this.db.exec('ROLLBACK'); return { conflict: 'not_latest' }; }
      const active = this.db.prepare("SELECT id FROM jobs WHERE thread_id = ? AND status IN ('queued','running','needs_input') LIMIT 1").get(threadId);
      if (active) { this.db.exec('ROLLBACK'); return { conflict: 'thread_active' }; }
      const repositoryIds = (this.db.prepare('SELECT repository_id FROM job_repositories WHERE job_id = ? ORDER BY rowid').all(parentId) as unknown as Array<{ repository_id: string }>).map((row) => row.repository_id);
      if (!this.repositoriesBelongTo(parentRow.project_id, repositoryIds)) { this.db.exec('ROLLBACK'); return { conflict: 'scope_invalid' }; }
      const id = crypto.randomUUID(); const now = new Date().toISOString();
      const context = this.buildConversationContext(threadId);
      this.db.prepare(`INSERT INTO jobs(id,project_id,prompt,status,created_at,updated_at,agent,parent_job_id,thread_id,conversation_context,follow_up_request_id,scope_mode,scope_state,scope_reasons)
        VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 'resolved', ?)`)
        .run(id, parentRow.project_id, message, now, now, parentRow.agent, parentId, threadId, context, requestId, parentRow.scope_mode, parentRow.scope_reasons);
      const insert = this.db.prepare('INSERT INTO job_repositories VALUES (?, ?)');
      for (const repositoryId of repositoryIds) insert.run(id, repositoryId);
      const insertRequested = this.db.prepare('INSERT INTO job_requested_repositories VALUES (?, ?)');
      for (const repositoryId of repositoryIds) insertRequested.run(id, repositoryId);
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
    const row = this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as unknown as JobRow | undefined;
    return row ? this.mapJob(row) : undefined;
  }

  setStatus(id: string, status: JobStatus): boolean {
    const result = this.db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    return Number(result.changes) > 0;
  }

  claim(id: string): boolean {
    const result = this.db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'").run(new Date().toISOString(), id);
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
}
