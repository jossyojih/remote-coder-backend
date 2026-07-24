import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { afterEach, test, describe } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { AttachmentStorage, ATTACHMENT_LIMITS } from '../src/attachments.js';
import { buildApp } from '../src/app.js';
import { buildJobPrompt } from '../src/agent-runtime.js';

const apps: FastifyInstance[] = [];
const token = 'test-token';
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'attach-test-'));
  mkdirSync(join(root, 'repo-a'));
  const attachRoot = join(root, 'attachments');
  const built = await buildApp({
    databasePath: join(root, 'test.sqlite'),
    workspaceRoot: root,
    apiToken: token,
    mockStepDelayMs: 1,
    attachmentsRoot: attachRoot,
  });
  apps.push(built.app);
  return { ...built, root, attachRoot };
}
const auth = { authorization: `Bearer ${token}` };

describe('AttachmentStorage', () => {
  test('requires absolute root path', () => {
    assert.throws(() => new AttachmentStorage('relative/path'), /absolute/);
  });

  test('validates MIME types correctly', () => {
    const root = mkdtempSync(join(tmpdir(), 'attach-mime-'));
    const storage = new AttachmentStorage(root);
    assert.equal(storage.validateMimeType('image/png'), true);
    assert.equal(storage.validateMimeType('image/jpeg'), true);
    assert.equal(storage.validateMimeType('text/plain'), true);
    assert.equal(storage.validateMimeType('application/json'), true);
    assert.equal(storage.validateMimeType('application/pdf'), true);
    assert.equal(storage.validateMimeType('application/octet-stream'), false);
    assert.equal(storage.validateMimeType('application/x-executable'), false);
    assert.equal(storage.validateMimeType('text/plain; charset=utf-8'), true);
  });

  test('validates extensions correctly', () => {
    const root = mkdtempSync(join(tmpdir(), 'attach-ext-'));
    const storage = new AttachmentStorage(root);
    assert.equal(storage.validateExtension('photo.png'), true);
    assert.equal(storage.validateExtension('doc.pdf'), true);
    assert.equal(storage.validateExtension('code.ts'), true);
    assert.equal(storage.validateExtension('data.json'), true);
    assert.equal(storage.validateExtension('readme.md'), true);
    assert.equal(storage.validateExtension('exploit.exe'), false);
    assert.equal(storage.validateExtension('script.sh'), false);
    assert.equal(storage.validateExtension('binary.bin'), false);
    assert.equal(storage.validateExtension('library.dll'), false);
  });

  test('validates filenames and rejects dangerous patterns', () => {
    const root = mkdtempSync(join(tmpdir(), 'attach-fname-'));
    const storage = new AttachmentStorage(root);
    assert.equal(storage.validateFilename('photo.png'), 'photo.png');
    assert.equal(storage.validateFilename('my file.png'), 'my_file.png');
    assert.throws(() => storage.validateFilename(''), /Invalid filename/);
    assert.throws(() => storage.validateFilename('a'.repeat(256)), /Invalid filename/);
    assert.throws(() => storage.validateFilename('../etc/passwd'), /invalid characters/);
    assert.throws(() => storage.validateFilename('..'), /Hidden files/);
    assert.throws(() => storage.validateFilename('.'), /Hidden files/);
    assert.throws(() => storage.validateFilename('.hidden'), /Hidden files/);
    assert.throws(() => storage.validateFilename('file\x00name'), /invalid characters/);
    assert.throws(() => storage.validateFilename('file<name'), /invalid characters/);
  });

  test('prevents path traversal in safePath', () => {
    const root = mkdtempSync(join(tmpdir(), 'attach-traverse-'));
    const storage = new AttachmentStorage(root);
    const validId = '00000000-0000-0000-0000-000000000001';
    const validProject = '00000000-0000-0000-0000-000000000002';
    const validThread = '00000000-0000-0000-0000-000000000003';
    assert.throws(() => (storage as any).safePath('not-a-uuid', validProject, validThread), /Invalid attachment ID/);
    assert.throws(() => (storage as any).safePath(validId, 'not-a-uuid', validThread), /Invalid project ID/);
    assert.throws(() => (storage as any).safePath(validId, validProject, 'not-a-uuid'), /Invalid thread ID/);
  });

  test('stores and retrieves files correctly', () => {
    const root = mkdtempSync(join(tmpdir(), 'attach-store-'));
    const storage = new AttachmentStorage(root);
    const id = '00000000-0000-0000-0000-000000000001';
    const projectId = '00000000-0000-0000-0000-000000000002';
    const threadId = '00000000-0000-0000-0000-000000000003';
    const jobId = '00000000-0000-0000-0000-000000000004';
    const content = Buffer.from('hello world');
    const stored = storage.store(id, projectId, threadId, jobId, 'test.txt', 'text/plain', content);
    assert.equal(stored.id, id);
    assert.equal(stored.filename, 'test.txt');
    assert.equal(stored.mimeType, 'text/plain');
    assert.equal(stored.sizeBytes, content.length);
    assert.ok(existsSync(stored.storagePath));

    const retrieved = storage.retrieve(id, projectId, threadId);
    assert.ok(retrieved);
    assert.deepEqual(retrieved.content, content);
    assert.equal(retrieved.meta.filename, 'test.txt');
  });

  test('enforces size limits', () => {
    const root = mkdtempSync(join(tmpdir(), 'attach-size-'));
    const storage = new AttachmentStorage(root);
    const id = '00000000-0000-0000-0000-000000000001';
    const projectId = '00000000-0000-0000-0000-000000000002';
    const threadId = '00000000-0000-0000-0000-000000000003';
    const jobId = '00000000-0000-0000-0000-000000000004';
    const tooLarge = Buffer.alloc(ATTACHMENT_LIMITS.maxFileSize + 1);
    assert.throws(() => storage.store(id, projectId, threadId, jobId, 'big.txt', 'text/plain', tooLarge), /exceeds/);
  });

  test('rejects disallowed MIME types', () => {
    const root = mkdtempSync(join(tmpdir(), 'attach-reject-'));
    const storage = new AttachmentStorage(root);
    const id = '00000000-0000-0000-0000-000000000001';
    const projectId = '00000000-0000-0000-0000-000000000002';
    const threadId = '00000000-0000-0000-0000-000000000003';
    const jobId = '00000000-0000-0000-0000-000000000004';
    const content = Buffer.from('binary data');
    assert.throws(() => storage.store(id, projectId, threadId, jobId, 'file.exe', 'application/x-executable', content), /type not allowed/);
  });

  test('rejects disallowed extensions', () => {
    const root = mkdtempSync(join(tmpdir(), 'attach-ext-reject-'));
    const storage = new AttachmentStorage(root);
    const id = '00000000-0000-0000-0000-000000000001';
    const projectId = '00000000-0000-0000-0000-000000000002';
    const threadId = '00000000-0000-0000-0000-000000000003';
    const jobId = '00000000-0000-0000-0000-000000000004';
    const content = Buffer.from('#!/bin/bash');
    assert.throws(() => storage.store(id, projectId, threadId, jobId, 'script.sh', 'text/plain', content), /type not allowed/);
  });

  test('lists attachments for thread', () => {
    const root = mkdtempSync(join(tmpdir(), 'attach-list-'));
    const storage = new AttachmentStorage(root);
    const projectId = '00000000-0000-0000-0000-000000000002';
    const threadId = '00000000-0000-0000-0000-000000000003';
    const jobId = '00000000-0000-0000-0000-000000000004';
    storage.store('00000000-0000-0000-0000-000000000010', projectId, threadId, jobId, 'file1.txt', 'text/plain', Buffer.from('a'));
    storage.store('00000000-0000-0000-0000-000000000011', projectId, threadId, jobId, 'file2.png', 'image/png', Buffer.from('b'));
    const listed = storage.listForThread(projectId, threadId);
    assert.equal(listed.length, 2);
    assert.ok(listed.some((m) => m.filename === 'file1.txt'));
    assert.ok(listed.some((m) => m.filename === 'file2.png'));
  });

  test('deletes all attachments for a thread', () => {
    const root = mkdtempSync(join(tmpdir(), 'attach-delete-'));
    const storage = new AttachmentStorage(root);
    const projectId = '00000000-0000-0000-0000-000000000002';
    const threadId = '00000000-0000-0000-0000-000000000003';
    const jobId = '00000000-0000-0000-0000-000000000004';
    storage.store('00000000-0000-0000-0000-000000000010', projectId, threadId, jobId, 'file1.txt', 'text/plain', Buffer.from('a'));
    storage.deleteForThread(projectId, threadId);
    assert.equal(storage.listForThread(projectId, threadId).length, 0);
    assert.equal(storage.retrieve('00000000-0000-0000-0000-000000000010', projectId, threadId), undefined);
  });

  test('pathsForJob returns valid paths only', () => {
    const root = mkdtempSync(join(tmpdir(), 'attach-paths-'));
    const storage = new AttachmentStorage(root);
    const projectId = '00000000-0000-0000-0000-000000000002';
    const threadId = '00000000-0000-0000-0000-000000000003';
    const jobId = '00000000-0000-0000-0000-000000000004';
    const id = '00000000-0000-0000-0000-000000000010';
    storage.store(id, projectId, threadId, jobId, 'file.txt', 'text/plain', Buffer.from('data'));
    const paths = storage.pathsForJob([{ id, projectId, threadId }]);
    assert.equal(paths.length, 1);
    assert.ok(isAbsolute(paths[0]));
    assert.ok(existsSync(paths[0]));
    const missing = storage.pathsForJob([{ id: '00000000-0000-0000-0000-000000000099', projectId, threadId }]);
    assert.equal(missing.length, 0);
  });

  test('stored paths are contained within ATTACHMENTS_ROOT', () => {
    const root = mkdtempSync(join(tmpdir(), 'attach-contained-'));
    const storage = new AttachmentStorage(root);
    const projectId = '00000000-0000-0000-0000-000000000002';
    const threadId = '00000000-0000-0000-0000-000000000003';
    const jobId = '00000000-0000-0000-0000-000000000004';
    const id = '00000000-0000-0000-0000-000000000010';
    const stored = storage.store(id, projectId, threadId, jobId, 'photo.png', 'image/png', Buffer.from('fake-png'));
    const rel = relative(root, stored.storagePath);
    assert.ok(!rel.startsWith('..'), 'stored path escapes root');
    assert.ok(!isAbsolute(rel), 'stored path is absolute relative');
  });
});

describe('Upload and retrieval API', () => {
  test('upload endpoint stores files and returns metadata', async () => {
    const { app } = await fixture();
    const boundary = '----FormBoundary123';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="test.txt"',
      'Content-Type: text/plain',
      '',
      'hello world',
      `--${boundary}--`,
    ].join('\r\n');
    const response = await app.inject({
      method: 'POST', url: '/attachments/upload', headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].filename, 'test.txt');
    assert.equal(result.attachments[0].mimeType, 'text/plain');
    assert.ok(result.attachments[0].id);
  });

  test('upload rejects executable file types', async () => {
    const { app } = await fixture();
    const boundary = '----FormBoundary456';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="exploit.exe"',
      'Content-Type: application/x-executable',
      '',
      'malicious content',
      `--${boundary}--`,
    ].join('\r\n');
    const response = await app.inject({
      method: 'POST', url: '/attachments/upload', headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /not allowed/);
  });

  test('upload enforces maximum file count', async () => {
    const { app } = await fixture();
    const boundary = '----FormBoundary789';
    const parts: string[] = [];
    for (let i = 0; i < 11; i++) {
      parts.push(`--${boundary}`);
      parts.push(`Content-Disposition: form-data; name="file"; filename="file${i}.txt"`);
      parts.push('Content-Type: text/plain');
      parts.push('');
      parts.push(`content ${i}`);
    }
    parts.push(`--${boundary}--`);
    const response = await app.inject({
      method: 'POST', url: '/attachments/upload', headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: parts.join('\r\n'),
    });
    assert.ok([400, 413].includes(response.statusCode), `Expected 400 or 413, got ${response.statusCode}`);
  });

  test('retrieval endpoint returns file with correct content-type', async () => {
    const { app, store, root } = await fixture();
    const boundary = '----FormBound';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="data.json"',
      'Content-Type: application/json',
      '',
      '{"key":"value"}',
      `--${boundary}--`,
    ].join('\r\n');
    const uploadResp = await app.inject({
      method: 'POST', url: '/attachments/upload', headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    const attachmentId = uploadResp.json().attachments[0].id;

    const projResp = await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'P', repositories: [{ name: 'A', path: join(root, 'repo-a') }] } });
    const projectId = projResp.json().id;
    const jobResp = await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId, prompt: 'test', attachments: [{ id: attachmentId, filename: 'data.json', mimeType: 'application/json', sizeBytes: 15 }] } });
    assert.equal(jobResp.statusCode, 201);

    const getResp = await app.inject({ url: `/attachments/${attachmentId}`, headers: auth });
    assert.equal(getResp.statusCode, 200);
    assert.equal(getResp.headers['content-type'], 'application/json');
  });

  test('retrieval returns 404 for unknown attachment', async () => {
    const { app } = await fixture();
    const response = await app.inject({ url: '/attachments/00000000-0000-0000-0000-000000000099', headers: auth });
    assert.equal(response.statusCode, 404);
  });
});

describe('Attachment metadata in job creation', () => {
  test('createJob with attachments records them in db', async () => {
    const { app, store, root } = await fixture();
    const projResp = await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'P', repositories: [{ name: 'A', path: join(root, 'repo-a') }] } });
    const projectId = projResp.json().id;
    const attachmentId = '00000000-1111-2222-3333-444444444444';
    const jobResp = await app.inject({
      method: 'POST', url: '/jobs', headers: auth,
      payload: { projectId, prompt: 'do something', attachments: [{ id: attachmentId, filename: 'screenshot.png', mimeType: 'image/png', sizeBytes: 1024 }] },
    });
    assert.equal(jobResp.statusCode, 201);
    const jobId = jobResp.json().id;
    const attachments = store.getAttachments(jobId);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].id, attachmentId);
    assert.equal(attachments[0].filename, 'screenshot.png');
  });

  test('followUp with attachments records them', async () => {
    const { app, store, root } = await fixture();
    const projResp = await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'P', repositories: [{ name: 'A', path: join(root, 'repo-a') }] } });
    const projectId = projResp.json().id;
    const jobResp = await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId, prompt: 'initial task' } });
    const jobId = jobResp.json().id;

    // Wait for mock job to complete
    await new Promise((r) => setTimeout(r, 300));

    const attachmentId = '00000000-aaaa-bbbb-cccc-dddddddddddd';
    const followResp = await app.inject({
      method: 'POST', url: `/jobs/${jobId}/continue`, headers: auth,
      payload: { message: 'follow up', requestId: crypto.randomUUID(), attachments: [{ id: attachmentId, filename: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: 2048 }] },
    });
    assert.equal(followResp.statusCode, 201);
    const followUpJobId = followResp.json().id;
    const attachments = store.getAttachments(followUpJobId);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].filename, 'doc.pdf');
  });
});

describe('buildJobPrompt includes attachment paths', () => {
  test('prompt includes attachment section when paths provided', () => {
    const job = {
      id: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      prompt: 'Fix the bug',
      agent: 'mock' as const,
      model: 'mock',
      status: 'running' as const,
      scopeMode: 'manual' as const,
      requestedRepositoryIds: [],
      resolvedRepositoryIds: [],
      scopeReasons: [],
      selectedRepositoryIds: [],
      threadId: '00000000-0000-0000-0000-000000000001',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      threadRepositoryPermissions: [],
    };
    const prepared = [{
      repository: { id: 'r1', projectId: job.projectId, name: 'repo', path: '/ws/repo', createdAt: '', effectivePromotionPolicy: 'review_required' as const },
      sourcePath: '/ws/repo', worktreePath: '/runs/wt1', branch: 'b', remoteName: 'origin', remoteUrl: 'https://example.com', targetBranch: 'main', baseCommitSha: 'abc', gitCommonDir: '/ws/repo/.git',
    }];
    const withAttachments = buildJobPrompt(job, prepared, '/runs', ['/data/attachments/proj/thread/id1']);
    assert.match(withAttachments, /Attached files/);
    assert.match(withAttachments, /\/data\/attachments\/proj\/thread\/id1/);

    const withoutAttachments = buildJobPrompt(job, prepared, '/runs');
    assert.doesNotMatch(withoutAttachments, /Attached files/);
  });

  test('prompt does not include attachment section when paths is empty', () => {
    const job = {
      id: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      prompt: 'Fix the bug',
      agent: 'mock' as const,
      model: 'mock',
      status: 'running' as const,
      scopeMode: 'manual' as const,
      requestedRepositoryIds: [],
      resolvedRepositoryIds: [],
      scopeReasons: [],
      selectedRepositoryIds: [],
      threadId: '00000000-0000-0000-0000-000000000001',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      threadRepositoryPermissions: [],
    };
    const prepared = [{
      repository: { id: 'r1', projectId: job.projectId, name: 'repo', path: '/ws/repo', createdAt: '', effectivePromotionPolicy: 'review_required' as const },
      sourcePath: '/ws/repo', worktreePath: '/runs/wt1', branch: 'b', remoteName: 'origin', remoteUrl: 'https://example.com', targetBranch: 'main', baseCommitSha: 'abc', gitCommonDir: '/ws/repo/.git',
    }];
    const result = buildJobPrompt(job, prepared, '/runs', []);
    assert.doesNotMatch(result, /Attached files/);
  });
});

describe('Schema validation for attachments', () => {
  test('rejects attachments exceeding total size limit', async () => {
    const { app, root } = await fixture();
    const projResp = await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'P', repositories: [{ name: 'A', path: join(root, 'repo-a') }] } });
    const projectId = projResp.json().id;
    const attachments = Array.from({ length: 6 }, (_, i) => ({
      id: crypto.randomUUID(),
      filename: `big${i}.png`,
      mimeType: 'image/png',
      sizeBytes: 9 * 1024 * 1024,
    }));
    const resp = await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId, prompt: 'test', attachments } });
    assert.equal(resp.statusCode, 400);
    assert.match(JSON.stringify(resp.json()), /50MB/);
  });

  test('rejects more than 10 attachments', async () => {
    const { app, root } = await fixture();
    const projResp = await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'P', repositories: [{ name: 'A', path: join(root, 'repo-a') }] } });
    const projectId = projResp.json().id;
    const attachments = Array.from({ length: 11 }, (_, i) => ({
      id: crypto.randomUUID(),
      filename: `file${i}.txt`,
      mimeType: 'text/plain',
      sizeBytes: 100,
    }));
    const resp = await app.inject({ method: 'POST', url: '/jobs', headers: auth, payload: { projectId, prompt: 'test', attachments } });
    assert.equal(resp.statusCode, 400);
  });
});
