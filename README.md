# Remote Engineering Command Center Backend

Phase 1 is a local Fastify API with durable SQLite storage, a single-worker job queue, SSE progress streaming, and a simulated agent. A project may contain any number of repositories and every job records the subset it operates on.

## Requirements and setup

Node.js 24 or newer is required because persistence uses the built-in `node:sqlite` module.

```bash
cp .env.example .env
npm install
npm run dev
```

Environment variables are not loaded automatically; export them in your shell or use your process manager. The server defaults to `127.0.0.1:4000`. `RUNNER_API_TOKEN` is required for all routes except `/health`. Repository paths must exist, resolve to real paths, and remain within `WORKSPACE_ROOT` (including after symlink resolution).

## API

Send `Authorization: Bearer <RUNNER_API_TOKEN>` on protected endpoints.

- `GET /health`
- `POST /projects`, `GET /projects`, `GET /projects/:id`
- `POST /jobs`, `GET /jobs` (optional `?projectId=`), `GET /jobs/:id`
- `GET /jobs/:id/events` (SSE; supports `Last-Event-ID` replay)
- `POST /jobs/:id/cancel`
- `POST /jobs/:id/reply` with `{ "message": "..." }` when status is `needs_input`

Create-project payloads contain `name` and a nonempty `repositories` array of `{ name, path }`. Create-job payloads contain `projectId`, `prompt`, and nonempty, unique `selectedRepositoryIds`. Selected repositories are checked against the project.

```bash
npm test
npm run build
npm start
```

The worker recovers jobs left in `running` after a process crash by re-queuing them at startup. Graceful shutdown aborts active mock work; on the next start it is recovered.
