# Remote Engineering Command Center Backend

The backend is a local Fastify API with durable SQLite storage, a single-worker job queue, SSE progress streaming, and both mock and real Codex execution adapters. A project may contain any number of repositories and every job records the subset it operates on.

## Requirements and setup

Node.js 24 or newer is required because persistence uses the built-in `node:sqlite` module.

```bash
cp .env.example .env
npm install
npm run dev
```

Environment variables are not loaded automatically; export them in your shell or use your process manager. The server defaults to `127.0.0.1:4000`. `RUNNER_API_TOKEN` is required for all routes except `/health`. Repository paths must exist, resolve to real paths, and remain within `WORKSPACE_ROOT` (including after symlink resolution).

Real Codex jobs use `CODEX_BIN` (default `codex`) and create persistent per-job Git worktrees below `RUNS_ROOT` (default `./data/runs`). `JOB_TIMEOUT_MS` defaults to 30 minutes and `JOB_KILL_GRACE_MS` defaults to 5 seconds. Codex runs ephemerally and non-interactively with JSONL output, approval policy `never`, and the `workspace-write` sandbox. The child receives a small environment allowlist; API keys and arbitrary job-controlled environment variables are not forwarded.

The service does not commit, push, clean, or remove worktrees. Each selected repository gets its own worktree and a `remote-engineer/<job-id>` branch. Operators are responsible for reviewing and eventually cleaning retained runs.

## API

Send `Authorization: Bearer <RUNNER_API_TOKEN>` on protected endpoints.

- `GET /health`
- `POST /projects`, `GET /projects`, `GET /projects/:id`
- `POST /jobs`, `GET /jobs` (optional `?projectId=`), `GET /jobs/:id`
- `GET /jobs/:id/events` (SSE; supports `Last-Event-ID` replay)
- `POST /jobs/:id/cancel`
- `POST /jobs/:id/reply` with `{ "message": "..." }` when status is `needs_input`

Create-project payloads contain `name` and a nonempty `repositories` array of `{ name, path }`. Create-job payloads contain `projectId`, `prompt`, nonempty unique `selectedRepositoryIds`, and an optional `agent` of `mock` or `codex` (default `mock`). Selected repositories are checked against the project. At execution time the Codex adapter re-resolves every path, checks the workspace boundary and Git repository status, then works only in isolated worktrees.

Codex JSONL session, progress, command, file-change, error, final-response, and token-usage records are persisted as job events and streamed by the existing SSE endpoint. Terminal jobs also receive one `repository_result` event per prepared repository with its branch, porcelain status, changed-file list, and diff statistics.

```bash
npm test
npm run build
npm start
```

The worker recovers jobs left in `running` after a process crash by re-queuing them at startup. Cancellation and graceful shutdown send `SIGTERM` to an active Codex process group on Linux, then `SIGKILL` after the configured grace period. Automated tests use a fake Codex executable and never call the real model.
