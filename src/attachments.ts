import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const ALLOWED_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml',
  'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css', 'text/javascript',
  'application/json', 'application/pdf', 'application/xml',
  'application/x-yaml', 'application/yaml',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.txt', '.md', '.csv', '.html', '.css', '.js', '.ts', '.tsx', '.jsx',
  '.json', '.pdf', '.xml', '.yaml', '.yml', '.log',
]);

export const ATTACHMENT_LIMITS = {
  maxFileSize: 10 * 1024 * 1024,
  maxFilesPerJob: 10,
  maxTotalSize: 50 * 1024 * 1024,
};

export interface AttachmentMetadata {
  id: string;
  jobId: string;
  threadId: string;
  projectId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface StoredAttachment extends AttachmentMetadata {
  storagePath: string;
}

export class AttachmentStorage {
  constructor(private readonly root: string) {
    if (!isAbsolute(root)) throw new Error('ATTACHMENTS_ROOT must be an absolute path');
    mkdirSync(root, { recursive: true });
  }

  validateMimeType(mimeType: string): boolean {
    const parts = mimeType.toLowerCase().split(';');
    const normalized = (parts[0] ?? '').trim();
    return ALLOWED_MIME_TYPES.has(normalized);
  }

  validateExtension(filename: string): boolean {
    const match = filename.toLowerCase().match(/\.[^.]+$/);
    const ext = match ? match[0] : '';
    return ALLOWED_EXTENSIONS.has(ext);
  }

  validateFilename(filename: string): string {
    if (!filename || filename.length > 255) throw new Error('Invalid filename');
    if (/[\x00-\x1f\x7f<>:"/\\|?*]/.test(filename)) throw new Error('Filename contains invalid characters');
    if (/^\.\.?$/.test(filename) || filename.startsWith('.')) throw new Error('Hidden files are not allowed');
    return filename.replace(/\s+/g, '_').slice(0, 200);
  }

  private safePath(id: string, projectId: string, threadId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid attachment ID');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) throw new Error('Invalid project ID');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) throw new Error('Invalid thread ID');
    const candidate = resolve(this.root, projectId, threadId, id);
    const rel = relative(this.root, candidate);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path traversal detected');
    return candidate;
  }

  store(id: string, projectId: string, threadId: string, jobId: string, filename: string, mimeType: string, content: Buffer): StoredAttachment {
    const safeFilename = this.validateFilename(filename);
    if (!this.validateExtension(safeFilename)) throw new Error('File type not allowed');
    if (!this.validateMimeType(mimeType)) throw new Error('MIME type not allowed');
    if (content.length > ATTACHMENT_LIMITS.maxFileSize) throw new Error(`File exceeds ${ATTACHMENT_LIMITS.maxFileSize / (1024 * 1024)}MB limit`);
    const storagePath = this.safePath(id, projectId, threadId);
    mkdirSync(dirname(storagePath), { recursive: true });
    const parts = mimeType.toLowerCase().split(';');
    const normalizedMimeType = (parts[0] ?? 'application/octet-stream').trim();
    const meta: AttachmentMetadata = {
      id, jobId, threadId, projectId, filename: safeFilename, mimeType: normalizedMimeType,
      sizeBytes: content.length, createdAt: new Date().toISOString(),
    };
    writeFileSync(`${storagePath}.meta.json`, JSON.stringify(meta, null, 2), 'utf8');
    writeFileSync(storagePath, content);
    return { ...meta, storagePath };
  }

  retrieve(id: string, projectId: string, threadId: string): { meta: AttachmentMetadata; content: Buffer } | undefined {
    try {
      const storagePath = this.safePath(id, projectId, threadId);
      const metaPath = `${storagePath}.meta.json`;
      if (!existsSync(metaPath) || !existsSync(storagePath)) return undefined;
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as AttachmentMetadata;
      const content = readFileSync(storagePath);
      return { meta, content };
    } catch { return undefined; }
  }

  listForThread(projectId: string, threadId: string): AttachmentMetadata[] {
    try {
      const threadPath = resolve(this.root, projectId, threadId);
      const rel = relative(this.root, threadPath);
      if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(threadPath)) return [];
      const entries = readdirSync(threadPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.meta.json'))
        .map((entry) => {
          try {
            return JSON.parse(readFileSync(join(threadPath, entry.name), 'utf8')) as AttachmentMetadata;
          } catch { return null; }
        })
        .filter((meta: AttachmentMetadata | null): meta is AttachmentMetadata => meta !== null);
    } catch { return []; }
  }

  deleteForThread(projectId: string, threadId: string): void {
    try {
      const threadPath = resolve(this.root, projectId, threadId);
      const rel = relative(this.root, threadPath);
      if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(threadPath)) return;
      rmSync(threadPath, { recursive: true, force: true });
    } catch {}
  }

  size(id: string, projectId: string, threadId: string): number {
    try {
      const storagePath = this.safePath(id, projectId, threadId);
      if (!existsSync(storagePath)) return 0;
      return statSync(storagePath).size;
    } catch { return 0; }
  }

  generateHash(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}
