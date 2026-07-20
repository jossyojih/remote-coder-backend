# Remote Engineering Command Center Backend

The backend is a local Fastify API with durable SQLite storage, a single-worker job queue, SSE progress streaming, and mock, Codex, and Claude Code execution adapters. A project may contain any number of repositories and every job records the subset it operates on.

## Requirements and setup

Node.js 24 or newer is required because persistence uses the built-in `node:sqlite` module.

```bash
cp .env.example .env
npm install
npm run dev
```

Environment variables are not loaded automatically; export them in your shell or use your process manager. The server defaults to `127.0.0.1:4000`. Protected routes accept either the existing `RUNNER_API_TOKEN` (for trusted scripts) or a short-lived app token. Repository paths must exist, resolve to real paths, and remain within `WORKSPACE_ROOT` (including after symlink resolution).

## Browser authentication and CORS

Generate the browser password hash and a 256-bit session secret locally. The command reads the password from hidden terminal input (or standard input for automation); it does not accept plaintext in command-line arguments or environment variables:

The generated values are single-quoted so the `$` characters in `APP_PASSWORD_HASH` remain literal in a POSIX-style `.env` file and when the file is loaded by a shell. To avoid displaying or logging the values, write them directly to a new private file (the `--silent` flag also keeps npm's status text out of that file), then load it alongside the rest of the service configuration:

```bash
umask 077
npm run --silent generate:auth > .env.auth
set -a
. ./.env.auth
set +a
```

Keep `.env.auth` outside source control and restrict it to the service account. Copy the quoted assignments directly into the EC2 service's secret environment configuration if that is how the service is configured. Do not save the plaintext password, generator output, runner token, or issued access tokens in source control, logs, browser persistent storage, or analytics. Set `APP_ORIGINS` to an exact comma-separated allowlist such as `https://your-pwa.onrender.com,http://localhost:3000`; entries must include the scheme and port where applicable and must not contain paths or wildcards. `APP_TOKEN_TTL_SECONDS` defaults to 900 seconds.

For an intentional one-year remembered-device login, set `APP_TOKEN_TTL_SECONDS=31536000` before starting the service. This makes every newly issued bearer token valid for up to one year; remembering it across browser restarts also requires the client to store it persistently. That substantially increases the impact of a stolen device, browser-storage compromise, XSS, or leaked token, so use the 900-second default when persistent login is not required and protect remembered devices appropriately. There is no per-token server-side revocation list. To reset the app password and invalidate all existing app tokens, stop the service, run the generator again, replace both `APP_PASSWORD_HASH` and `APP_SESSION_SECRET` in the secret configuration, and restart the service. Rotating only the password hash does not revoke tokens already issued with the old session secret.

The PWA calls `POST /auth/login` with `{ "password": "..." }`, keeps the returned `accessToken` in memory, and sends `Authorization: Bearer <accessToken>` on API and SSE requests. The response also includes an ISO-8601 `expiresAt`; log in again after expiry. No cookie is issued. Login attempts are limited in memory per client IP (five attempts per minute by default), which is suitable for this single-instance V1 but is not a distributed limiter.

CORS rejects requests carrying an unlisted `Origin`, answers allowed `OPTIONS` preflights with `Authorization`, `Content-Type`, and `Last-Event-ID` support, and exposes the exact allowed origin on normal and SSE responses. Requests without an `Origin` remain available to trusted scripts. Keep EC2 behind TLS and ensure the proxy passes the real client address consistently.

Real Codex jobs use `CODEX_BIN` (default `codex`) and create persistent per-job Git worktrees below `RUNS_ROOT` (default `./data/runs`). `JOB_TIMEOUT_MS` defaults to 30 minutes and `JOB_KILL_GRACE_MS` defaults to 5 seconds. Codex runs ephemerally and non-interactively with JSONL output, approval policy `never`, and the `workspace-write` sandbox. The child receives a small environment allowlist; API keys and arbitrary job-controlled environment variables are not forwarded.

Real Claude jobs use `CLAUDE_BIN` (default `claude`) and `CLAUDE_MODEL` (default `sonnet`). Claude runs non-interactively with `stream-json`, no session persistence, no MCP servers, and an explicit built-in tool list. Its permission mode is `dontAsk`: explicitly allowed work tools can run unattended, while permission checks are not globally bypassed. This is less permissive than `bypassPermissions`/`--dangerously-skip-permissions`; the trade-off is that operations outside the allowlist fail instead of prompting. `Bash` remains powerful, so Claude is additionally constrained by explicit repository paths, retained per-job worktrees, a restricted environment, and the job prompt boundary. Run the service itself in an OS sandbox if hostile prompts are in scope.

The service does not commit, push, clean, or remove worktrees. Each execution attempt gets an immutable directory below `<job-id>/<attempt-id>`; every selected repository gets its own worktree on a `remote-engineer/<job-id>/<attempt-id>` branch. Retries therefore leave stale or still-active attempts untouched. Operators are responsible for reviewing and eventually cleaning retained runs.

## API

Send `Authorization: Bearer <RUNNER_API_TOKEN-or-app-access-token>` on protected endpoints.

- `GET /health`
- `POST /auth/login` with `{ "password": "..." }`
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
