import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/database.js';
import { JobEventBus, JobWorker } from '../src/worker.js';

test('auto scope does not propose multiple times for repeated scope_required events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'no-duplicate-approval-'));
  mkdirSync(join(root, 'one'));
  mkdirSync(join(root, 'two'));

  const store = new Store(join(root, 'db.sqlite'));
  const project = store.createProject('P', [
    { name: 'One', path: join(root, 'one') },
    { name: 'Two', path: join(root, 'two') }
  ]);

  const job = store.createJob(project.id, 'Work', [], 'mock', 'auto');
  store.resolveScope(job.id, [project.repositories[0].id], [
    { repositoryId: project.repositories[0].id, reason: 'Selected.' }
  ]);

  let emitCallCount = 0;
  const worker = new JobWorker(
    store,
    new JobEventBus(),
    {
      mock: {
        async run(_job, _repositories, emit) {
          // Emit scope_required TWICE to simulate agent requesting approval multiple times
          emit('scope_required', 'Need another repository (first)', {
            suggestedRepositoryIds: [project.repositories[1].id],
            reasons: [{ repositoryId: project.repositories[1].id, reason: 'The API implementation is located there.' }]
          });
          emitCallCount++;

          // Wait a bit, then emit again
          await new Promise((resolve) => setTimeout(resolve, 10));

          emit('scope_required', 'Need another repository (second)', {
            suggestedRepositoryIds: [project.repositories[1].id],
            reasons: [{ repositoryId: project.repositories[1].id, reason: 'The API implementation is located there.' }]
          });
          emitCallCount++;
        }
      }
    },
    { error() {} } as any,
    5
  );

  worker.start();

  // Wait for job to reach needs_input status
  for (let attempt = 0; attempt < 100 && store.getJob(job.id)?.status !== 'needs_input'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(store.getJob(job.id)?.status, 'needs_input');
  assert.deepEqual(store.getJob(job.id)?.proposedRepositoryIds, [project.repositories[1].id]);

  // Verify the agent did emit twice
  assert.equal(emitCallCount, 2);

  // Count how many times scope approval was actually requested (should be only 1)
  const events = store.events(job.id);
  const scopeRequiredEvents = events.filter((event) => event.type === 'scope_required');
  const statusNeedsInputEvents = events.filter(
    (event) => event.type === 'status' && event.data && typeof event.data === 'object' && 'status' in event.data && event.data.status === 'needs_input'
  );

  // The agent emitted 2 scope_required events, but only 1 should result in a status update
  assert.equal(scopeRequiredEvents.length, 2, 'Should have 2 scope_required events');
  assert.equal(statusNeedsInputEvents.length, 1, 'Should have exactly 1 needs_input status event');

  await worker.stop();
  store.close();
});
