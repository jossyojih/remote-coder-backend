# Backend Agent Rules

## Safety boundaries

- Work only in this backend repository. Never inspect or modify a sibling frontend repository.
- Do not deploy, push, use `sudo`, change system configuration, or commit unless explicitly authorized.
- Treat `WORKSPACE_ROOT` as a hard filesystem boundary. Resolve real paths before accepting repositories so symlinks cannot escape it.
- Bind network listeners to `127.0.0.1` by default and never log bearer tokens or prompt secrets.
- Agent adapters must receive an explicit list of selected repositories. They may not infer additional repositories or traverse outside those paths.

## Multi-repository invariants

- A project owns one or more repositories.
- A job belongs to exactly one project and stores one or more unique selected repository IDs.
- Every selected repository must belong to the job's project; enforce this at the API boundary and preserve it in storage.
- Cancellation, events, replies, and future agent execution are scoped by job ID, never by a global current repository.
- Future real adapters must keep work isolated to all and only the job's selected repository paths.
