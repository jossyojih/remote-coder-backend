# Remote Engineering Command Center Backend

The backend is a local Fastify API with durable SQLite storage, a single-worker job queue, SSE progress streaming, and mock, Codex, and Claude Code execution adapters. A project may contain any number of repositories and every job records the subset it operates on.

## Requirements and setup

Node.js 24 or newer is required because persistence uses the built-in `node:sqlite` module.

```bash
cp .env.example .env
npm install
npm run dev
```

Environment variables are not loaded automatically; export them in your shell or use your process manager. The server defaults to `127.0.0.1:4000`. `RUNNER_API_TOKEN` is required for all routes except `/health`. Repository paths must exist, resolve to real paths, and remain within `WORKSPACE_ROOT` (including after symlink resolution).

Real Codex jobs use `CODEX_BIN` (default `codex`) and create persistent per-job Git worktrees below `RUNS_ROOT` (default `./data/runs`). `JOB_TIMEOUT_MS` defaults to 30 minutes and `JOB_KILL_GRACE_MS` defaults to 5 seconds. Codex runs ephemerally and non-interactively with JSONL output, approval policy `never`, and the `workspace-write` sandbox. The child receives a small environment allowlist; API keys and arbitrary job-controlled environment variables are not forwarded.

Real Claude jobs use `CLAUDE_BIN` (default `claude`) and `CLAUDE_MODEL` (default `sonnet`). Claude runs non-interactively with `stream-json`, no session persistence, no MCP servers, and an explicit built-in tool list. Its permission mode is `dontAsk`: explicitly allowed work tools can run unattended, while permission checks are not globally bypassed. This is less permissive than `bypassPermissions`/`--dangerously-skip-permissions`; the trade-off is that operations outside the allowlist fail instead of prompting. `Bash` remains powerful, so Claude is additionally constrained by explicit repository paths, retained per-job worktrees, a restricted environment, and the job prompt boundary. Run the service itself in an OS sandbox if hostile prompts are in scope.

The service does not commit, push, clean, or remove worktrees. Each selected repository gets its own worktree and a `remote-engineer/<job-id>` branch. Operators are responsible for reviewing and eventually cleaning retained runs.

## API

Send `Authorization: Bearer <RUNNER_API_TOKEN>` on protected endpoints.

- `GET /health`
- `POST /projects`, `GET /projects`, `GET /projects/:id`
- `POST /jobs`, `GET /jobs` (optional `?projectId=`), `GET /jobs/:id`
- `GET /jobs/:id/events` (SSE; supports `Last-Event-ID` replay)
- `POST /jobs/:id/cancel`
- `POST /jobs/:id/reply` with `{ "message": "..." }` when status is `needs_input`

Create-project payloads contain `name` and a nonempty `repositories` array of `{ name, path }`. Create-job payloads contain `projectId`, `prompt`, nonempty unique `selectedRepositoryIds`, and an optional `agent` of `mock`, `codex`, or `claude` (default `mock`). Selected repositories are checked against the project. At execution time real adapters re-resolve every path, check the workspace boundary and Git repository status, then work only in isolated worktrees.

Codex JSONL and Claude stream-JSON session, progress, command, file-change, error, final-response, and token-usage records are persisted as job events and streamed by the existing SSE endpoint. Successfully completed jobs also receive one `repository_result` event per prepared repository with its branch, porcelain status, changed-file list, and diff statistics. Malformed, failed, or incomplete agent protocols fail the job and never report successful repository results.

```bash
npm test
npm run build
npm start
```

The worker recovers jobs left in `running` after a process crash by re-queuing them at startup. Cancellation and graceful shutdown send `SIGTERM` to an active agent process group on Linux, then `SIGKILL` after the configured grace period. Automated tests use fake Codex and Claude executables and never call either real model service.

For a safe real read-only Claude smoke test, create a project for a disposable Git repository inside `WORKSPACE_ROOT`, submit a job with `agent: "claude"` and a prompt such as “Read the selected repository and summarize its README; do not modify files or run commands,” then verify the terminal status, final response, and an empty `changedFiles` list in the retained worktree's `repository_result`. Do not use a repository containing secrets.
