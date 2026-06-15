import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

import type {
  ArtifactFormat,
  ArtifactType,
  FileActivity,
  FileAsset,
  FileAssetCategory,
  FileAssetContent,
  FileAssetUpdateInput,
  FileBatchActionInput,
  FileFolder,
  FileFolderUpdateInput,
  FileListResult,
  FilePermission,
  FilePermissionRole,
  FileAssetSource,
  Task,
} from '@xuanzhi/shared/protocol';

import type { MemoryStore } from '../repositories/memoryStore.js';

type FileAssetIndex = {
  version: 1;
  files: FileAsset[];
  folders?: FileFolder[];
  activities?: FileActivity[];
  permissions?: FilePermission[];
};

type FileLookup = {
  ownerId: string;
  file: FileAsset;
  index: FileAssetIndex;
  indexPath: string;
  root: string;
};

type CreateFileAssetInput = {
  task: Task;
  artifactId?: string;
  parentFileId?: string;
  title: string;
  type?: ArtifactType;
  format?: ArtifactFormat;
  content: unknown;
  fileName?: string;
  mimeType?: string;
  category?: FileAssetCategory;
  source?: FileAssetSource;
  summary?: string;
  tags?: string[];
};

type CreateUploadedFileInput = {
  userId: string;
  task?: Task;
  name: string;
  content?: string;
  buffer?: Buffer;
  encoding?: 'text' | 'base64';
  mimeType?: string;
  category?: FileAssetCategory;
  folderId?: string;
  parentFileId?: string;
  title?: string;
  summary?: string;
  tags?: string[];
};

type ListFilesResult = FileListResult;

const categoryFolders: Record<FileAssetCategory, string> = {
  documents: 'documents',
  spreadsheets: 'spreadsheets',
  images: 'images',
  presentations: 'presentations',
  reports: 'reports',
  code: 'code',
  data: 'data',
  others: 'others',
};

const extensionByFormat: Record<ArtifactFormat, string> = {
  diff: '.diff',
  json: '.json',
  markdown: '.md',
  text: '.txt',
};

const mimeByExtension: Record<string, string> = {
  '.csv': 'text/csv',
  '.diff': 'text/x-diff',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.jsonl': 'application/jsonl',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};

const maxInlineTextPreviewBytes = 1024 * 1024;
const maxInlineImagePreviewBytes = 5 * 1024 * 1024;
const maxContextFiles = 10;
const maxContextTextChars = 30_000;

function getIndexLockStaleMs() {
  const configured = Number(process.env.XUANZHI_FILE_INDEX_LOCK_STALE_MS ?? 60_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
}

function nowIso() {
  return new Date().toISOString();
}

function getFileRoot() {
  return process.env.XUANZHI_FILE_ROOT?.trim() || join(process.cwd(), '.xuanzhi', 'workspaces');
}

function sanitizeSegment(value: string) {
  return value
    .trim()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function safeWorkspaceKey(value: string | undefined, userId: string) {
  const source = value?.split('/').filter(Boolean).at(-1) || userId;
  return sanitizeSegment(source) || sanitizeSegment(userId) || 'workspace';
}

function safeFileStem(value: string) {
  return sanitizeSegment(value).replace(/\.+$/g, '').slice(0, 80) || 'untitled';
}

function normalizeExtension(value: string | undefined) {
  if (!value) return '';
  const ext = value.startsWith('.') ? value : `.${value}`;
  return ext.toLowerCase().replace(/[^a-z0-9.]/g, '');
}

function extensionFromName(fileName: string | undefined) {
  return normalizeExtension(fileName ? extname(fileName) : undefined);
}

function inferCategory(input: Pick<CreateFileAssetInput, 'category' | 'type' | 'format' | 'fileName' | 'mimeType'>): FileAssetCategory {
  if (input.category && input.category !== 'data') return input.category;

  const extension = extensionFromName(input.fileName);
  const mimeType = input.mimeType ?? (extension ? mimeByExtension[extension] : undefined);

  if (mimeType?.startsWith('image/')) return 'images';
  if (['.xlsx', '.xls', '.csv'].includes(extension)) return 'spreadsheets';
  if (['.pptx', '.ppt'].includes(extension)) return 'presentations';
  if (extension === '.pdf' || mimeType === 'application/pdf') return 'reports';
  if (
    extension === '.ts'
    || extension === '.tsx'
    || extension === '.js'
    || extension === '.jsx'
    || extension === '.py'
    || extension === '.java'
    || extension === '.sql'
    || extension === '.ipynb'
    || extension === '.diff'
    || extension === '.json'
    || extension === '.jsonl'
    || input.type === 'code_diff'
    || input.format === 'diff'
    || input.format === 'json'
  ) {
    return 'code';
  }
  if (
    ['.md', '.txt', '.doc', '.docx', '.html'].includes(extension)
    || input.format === 'markdown'
    || input.format === 'text'
    || input.type === 'plan'
    || input.type === 'meeting_draft'
    || input.type === 'report'
    || input.type === 'final_answer'
  ) {
    return 'documents';
  }
  return 'others';
}

function inferExtension(input: Pick<CreateFileAssetInput, 'format' | 'fileName' | 'mimeType' | 'category'>) {
  const fromName = extensionFromName(input.fileName);
  if (fromName) return fromName;
  if (input.format) return extensionByFormat[input.format];
  if (input.mimeType === 'image/png') return '.png';
  if (input.mimeType === 'image/jpeg') return '.jpg';
  if (input.mimeType === 'application/pdf') return '.pdf';
  if (input.category === 'spreadsheets') return '.csv';
  return '.txt';
}

function contentToBuffer(content: unknown, format: ArtifactFormat | undefined) {
  if (typeof content === 'string') {
    return Buffer.from(content, 'utf8');
  }
  if (content instanceof Uint8Array) {
    return Buffer.from(content);
  }
  if (format === 'json' || typeof content === 'object') {
    return Buffer.from(JSON.stringify(content ?? null, null, 2), 'utf8');
  }
  return Buffer.from(String(content ?? ''), 'utf8');
}

function uploadedContentToBuffer(input: Pick<CreateUploadedFileInput, 'buffer' | 'content' | 'encoding'>) {
  if (input.buffer) return input.buffer;
  return input.encoding === 'base64'
    ? Buffer.from(input.content ?? '', 'base64')
    : Buffer.from(input.content ?? '', 'utf8');
}

function contentHash(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function previewFromBuffer(buffer: Buffer, mimeType: string) {
  if (!mimeType.startsWith('text/') && mimeType !== 'application/json') return undefined;
  return buffer.toString('utf8').slice(0, 800);
}

function supportsTextPreview(file: FileAsset) {
  return (
    file.mimeType.startsWith('text/')
    || file.mimeType === 'application/json'
    || ['md', 'txt', 'json', 'jsonl', 'diff', 'csv', 'svg', 'ts', 'tsx', 'js', 'jsx', 'py', 'java'].includes(file.extension)
  );
}

function readPreviewBytes(absolutePath: string, maxBytes: number) {
  const fd = openSync(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function readFilePreview(file: FileAsset, absolutePath: string): FileAssetContent | undefined {
  if (!existsSync(absolutePath)) return undefined;
  const stat = statSync(absolutePath);
  if (file.mimeType.startsWith('image/')) {
    if (stat.size > maxInlineImagePreviewBytes) {
      return {
        file,
        kind: 'unsupported',
        message: '图片较大，请下载后查看。',
      };
    }
    const buffer = readFileSync(absolutePath);
    return {
      file,
      kind: 'image',
      dataUrl: `data:${file.mimeType};base64,${buffer.toString('base64')}`,
    };
  }

  if (supportsTextPreview(file)) {
    return {
      file,
      kind: 'text',
      text: readPreviewBytes(absolutePath, Math.min(stat.size, maxInlineTextPreviewBytes)).toString('utf8'),
    };
  }

  return {
    file,
    kind: 'unsupported',
    message: '该文件类型暂不支持在线预览，请下载后打开。',
  };
}

function formatDatePrefix() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
}

function buildStoredFileName(fileId: string, stem: string, extension: string) {
  return `${formatDatePrefix()}_${safeFileStem(stem)}_${fileId.replace(/^file_/, '').slice(0, 8)}${extension}`;
}

function readIndex(indexPath: string): FileAssetIndex {
  if (!existsSync(indexPath)) {
    return { version: 1, files: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as FileAssetIndex;
    if (parsed?.version === 1 && Array.isArray(parsed.files)) {
      parsed.files = parsed.files.map((file) => ({
        ...file,
        versionGroupId: file.versionGroupId ?? file.id,
        version: file.version ?? 1,
      }));
      parsed.folders ??= [];
      parsed.activities ??= [];
      parsed.permissions ??= [];
      return parsed;
    }
  } catch {
    try {
      renameSync(indexPath, `${indexPath}.corrupt.${Date.now()}`);
    } catch {
      // If backup fails, keep the app alive and avoid throwing from read paths.
    }
  }
  return { version: 1, files: [], folders: [], activities: [], permissions: [] };
}

function writeIndex(indexPath: string, index: FileAssetIndex) {
  mkdirSync(dirname(indexPath), { recursive: true });
  const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(index, null, 2), 'utf8');
  renameSync(tempPath, indexPath);
}

const lockWaitBuffer = new SharedArrayBuffer(4);
const lockWaitView = new Int32Array(lockWaitBuffer);

function removeStaleIndexLock(lockPath: string) {
  try {
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < getIndexLockStaleMs()) return false;
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number };
      if (typeof lock.pid === 'number') {
        try {
          process.kill(lock.pid, 0);
          return false;
        } catch {
          // The lock holder is gone, so the stale lock can be removed.
        }
      }
    } catch {
      // Older lock files may not contain metadata; age is the best signal there.
    }
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : undefined;
    return code === 'ENOENT';
  }
}

function withIndexLock<T>(indexPath: string, fn: () => T): T {
  const lockPath = `${indexPath}.lock`;
  mkdirSync(dirname(indexPath), { recursive: true });
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : undefined;
      if (code !== 'EEXIST') throw error;
      if (removeStaleIndexLock(lockPath)) {
        continue;
      }
      Atomics.wait(lockWaitView, 0, 0, 10);
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: nowIso() }), 'utf8');
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // A stale lock cleanup failure should not mask the original operation.
    }
  }
}

export function createFileAssetService(store: MemoryStore) {
  function getUserAgent(userId: string, task?: Task) {
    if (task?.agentId) {
      const agent = store.getAgent(task.agentId);
      if (agent) return agent;
    }
    return store.getAgentByUserId(userId);
  }

  function getWorkspaceInfo(userId: string, task?: Task) {
    const agent = getUserAgent(userId, task);
    const logicalWorkspace = agent?.workspace || `xuanzhi-user-${userId}`;
    const workspaceKey = safeWorkspaceKey(logicalWorkspace, userId);
    const root = join(getFileRoot(), workspaceKey);
    const indexPath = join(root, 'xuanzhi', 'index', 'files.manifest.json');
    return { agent, logicalWorkspace, root, indexPath };
  }

  function enrichFile(index: FileAssetIndex, file: FileAsset, options: { includePermissions?: boolean } = {}): FileAsset {
    if (!options.includePermissions) {
      const { permissions: _permissions, ...publicFile } = file;
      return publicFile;
    }
    return {
      ...file,
      permissions: (index.permissions ?? []).filter((permission) => permission.fileId === file.id),
    };
  }

  function canReturnFileToUser(file: FileAsset, userId: string) {
    return file.userId === userId || !file.deletedAt;
  }

  function writeUserIndex(userId: string, update: (index: FileAssetIndex) => void) {
    const { indexPath } = getWorkspaceInfo(userId);
    return withIndexLock(indexPath, () => {
      const index = readIndex(indexPath);
      update(index);
      writeIndex(indexPath, index);
      return index;
    });
  }

  function folderExists(index: FileAssetIndex, userId: string, folderId: string | undefined | null) {
    if (!folderId) return true;
    return (index.folders ?? []).some((folder) => folder.userId === userId && folder.id === folderId);
  }

  function wouldCreateFolderCycle(index: FileAssetIndex, folderId: string, parentFolderId: string | undefined) {
    let currentParentId = parentFolderId;
    const seen = new Set<string>();
    while (currentParentId) {
      if (currentParentId === folderId || seen.has(currentParentId)) return true;
      seen.add(currentParentId);
      currentParentId = (index.folders ?? []).find((folder) => folder.id === currentParentId)?.parentFolderId;
    }
    return false;
  }

  function isFileSharedWith(index: FileAssetIndex, fileId: string, userId: string) {
    const now = Date.now();
    const targetFile = index.files.find((file) => file.id === fileId);
    return (index.permissions ?? []).some((permission) => (
      (permission.fileId === fileId || (targetFile?.versionGroupId && permission.versionGroupId === targetFile.versionGroupId))
      && (permission.role === 'viewer' || permission.role === 'editor')
      && !permission.revokedAt
      && (!permission.expiresAt || new Date(permission.expiresAt).getTime() > now)
      && (
        (permission.principalType === 'user' && permission.principalId === userId)
      )
    ));
  }

  function canReadFile(index: FileAssetIndex, file: FileAsset, userId: string) {
    return file.userId === userId || isFileSharedWith(index, file.id, userId);
  }

  function isFileEditableBy(index: FileAssetIndex, file: FileAsset, userId: string) {
    if (file.userId === userId) return true;
    const now = Date.now();
    return (index.permissions ?? []).some((permission) => (
      (permission.fileId === file.id || permission.versionGroupId === file.versionGroupId)
      && permission.role === 'editor'
      && !permission.revokedAt
      && (!permission.expiresAt || new Date(permission.expiresAt).getTime() > now)
      && permission.principalType === 'user'
      && permission.principalId === userId
    ));
  }

  function getAccessibleFile(userId: string, fileId: string): FileLookup | undefined {
    for (const owner of store.listUsers()) {
      const { indexPath, root } = getWorkspaceInfo(owner.id);
      const index = readIndex(indexPath);
      const file = index.files.find((item) => item.id === fileId);
      if (file && canReadFile(index, file, userId) && canReturnFileToUser(file, userId)) {
        return { ownerId: owner.id, file, index, indexPath, root };
      }
    }
    return undefined;
  }

  function getEditableFile(userId: string, fileId: string): FileLookup | undefined {
    for (const owner of store.listUsers()) {
      const { indexPath, root } = getWorkspaceInfo(owner.id);
      const index = readIndex(indexPath);
      const file = index.files.find((item) => item.id === fileId);
      if (file && isFileEditableBy(index, file, userId) && canReturnFileToUser(file, userId)) {
        return { ownerId: owner.id, file, index, indexPath, root };
      }
    }
    return undefined;
  }

  function getPublicFileByToken(token: string): FileLookup | undefined {
    const now = Date.now();
    for (const owner of store.listUsers()) {
      const { indexPath, root } = getWorkspaceInfo(owner.id);
      const index = readIndex(indexPath);
      const permission = (index.permissions ?? []).find((item) => (
        item.principalType === 'public_link'
        && item.principalId === token
        && item.role === 'viewer'
        && !item.revokedAt
        && (!item.expiresAt || new Date(item.expiresAt).getTime() > now)
      ));
      if (!permission) continue;
      const file = latestByVersionGroup(index.files)
        .find((item) => (
          (item.id === permission.fileId || item.versionGroupId === permission.versionGroupId)
          && !item.deletedAt
        ));
      if (file) {
        return { ownerId: owner.id, file, index, indexPath, root };
      }
    }
    return undefined;
  }

  function latestByVersionGroup(files: FileAsset[]) {
    const byGroup = new Map<string, FileAsset>();
    files.forEach((file) => {
      const key = file.versionGroupId ?? file.id;
      const current = byGroup.get(key);
      if (!current || file.version > current.version || (file.version === current.version && file.updatedAt > current.updatedAt)) {
        byGroup.set(key, file);
      }
    });
    return [...byGroup.values()];
  }

  function paginateFiles(files: FileAsset[], options: { limit?: number; offset?: number } = {}): ListFilesResult {
    const total = files.length;
    const limit = Math.min(Math.max(options.limit ?? total, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const page = files.slice(offset, offset + limit);
    return {
      files: page,
      total,
      limit,
      offset,
      hasMore: offset + page.length < total,
    };
  }

  function findDuplicate(index: FileAssetIndex, userId: string, hash: string, excludeFileId?: string) {
    return index.files.find((file) => (
      file.userId === userId
      && file.id !== excludeFileId
      && file.contentHash === hash
      && !file.deletedAt
    ));
  }

  function recordActivity(index: FileAssetIndex, input: {
    fileId: string;
    userId: string;
    type: FileActivity['type'];
    message: string;
    metadata?: unknown;
  }) {
    const activity: FileActivity = {
      id: `fact_${randomUUID()}`,
      fileId: input.fileId,
      userId: input.userId,
      type: input.type,
      message: input.message,
      metadata: input.metadata,
      createdAt: nowIso(),
    };
    index.activities = [activity, ...(index.activities ?? [])].slice(0, 1000);
    return activity;
  }

  function nextVersion(index: FileAssetIndex, versionGroupId: string) {
    const versions = index.files.filter((file) => file.versionGroupId === versionGroupId);
    return Math.max(0, ...versions.map((file) => file.version ?? 1)) + 1;
  }

  function upsertFile(index: FileAssetIndex, fileAsset: FileAsset) {
    index.files = [fileAsset, ...index.files.filter((file) => file.id !== fileAsset.id)];
  }

  function listFiles(userId: string, filters: {
    taskId?: string;
    category?: FileAssetCategory;
    search?: string;
    source?: FileAssetSource;
    folderId?: string;
    favorite?: boolean;
    deleted?: boolean;
    includeAllVersions?: boolean;
    limit?: number;
    offset?: number;
  } = {}) {
    const keyword = filters.search?.trim().toLowerCase();
    const readable = store.listUsers().flatMap((owner) => {
      const { indexPath } = getWorkspaceInfo(owner.id);
      const index = readIndex(indexPath);
      return index.files
        .filter((file) => canReadFile(index, file, userId))
        .filter((file) => canReturnFileToUser(file, userId))
        .map((file) => enrichFile(index, file, { includePermissions: file.userId === userId }));
    });
    const filtered = readable
      .filter((file) => (filters.deleted ? Boolean(file.deletedAt) : !file.deletedAt))
      .filter((file) => (filters.taskId ? file.taskId === filters.taskId : true))
      .filter((file) => (filters.category ? file.category === filters.category : true))
      .filter((file) => (filters.source ? file.source === filters.source : true))
      .filter((file) => (filters.folderId ? file.folderId === filters.folderId : true))
      .filter((file) => (filters.favorite ? file.isFavorite : true))
      .filter((file) => (
        keyword
          ? `${file.name} ${file.title} ${file.summary ?? ''} ${file.previewText ?? ''} ${file.workspacePath}`
            .toLowerCase()
            .includes(keyword)
          : true
      ));
    return (filters.includeAllVersions ? filtered : latestByVersionGroup(filtered))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  function listFilesPage(userId: string, filters: Parameters<typeof listFiles>[1] = {}): ListFilesResult {
    return paginateFiles(listFiles(userId, filters), filters);
  }

  function getFile(userId: string, fileId: string) {
    const lookup = getAccessibleFile(userId, fileId);
    if (!lookup) return undefined;
    return {
      file: enrichFile(lookup.index, lookup.file, { includePermissions: lookup.ownerId === userId }),
      absolutePath: join(lookup.root, lookup.file.path),
    };
  }

  function createFileFromArtifact(input: CreateFileAssetInput) {
    const { agent, logicalWorkspace, root, indexPath } = getWorkspaceInfo(input.task.userId, input.task);
    const category = inferCategory(input);
    const extension = inferExtension({ ...input, category });
    const mimeType = input.mimeType ?? mimeByExtension[extension] ?? 'text/plain';
    const nameStem = safeFileStem(input.fileName?.replace(/\.[^.]+$/, '') || input.title);
    const fileId = `file_${randomUUID()}`;
    const name = buildStoredFileName(fileId, nameStem, extension);
    const relativePath = ['xuanzhi', 'files', categoryFolders[category], name].join('/');
    const absolutePath = join(root, relativePath);
    const buffer = contentToBuffer(input.content, input.format);
    const hash = contentHash(buffer);
    const createdAt = nowIso();

    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, buffer);

    const stat = statSync(absolutePath);
    let fileAsset: FileAsset = {
      id: fileId,
      userId: input.task.userId,
      taskId: input.task.id,
      agentId: agent?.id ?? input.task.agentId,
      artifactId: input.artifactId,
      versionGroupId: fileId,
      version: 1,
      name,
      title: input.title,
      category,
      source: input.source ?? 'assistant_generated',
      mimeType,
      extension: extension.replace(/^\./, ''),
      sizeBytes: stat.size,
      contentHash: hash,
      path: relativePath,
      workspacePath: `${logicalWorkspace.replace(/\/+$/, '')}/${relativePath}`,
      summary: input.summary,
      previewText: previewFromBuffer(buffer, mimeType),
      tags: input.tags,
      createdAt,
      updatedAt: createdAt,
    };

    withIndexLock(indexPath, () => {
      const index = readIndex(indexPath);
      const parentFile = input.parentFileId
        ? index.files.find((file) => file.id === input.parentFileId && file.userId === input.task.userId)
        : undefined;
      if (input.parentFileId && !parentFile) {
        throw new Error('父版本文件不存在');
      }
      const versionGroupId = parentFile?.versionGroupId ?? parentFile?.id ?? fileAsset.id;
      const version = parentFile ? nextVersion(index, versionGroupId) : 1;
      fileAsset = {
        ...fileAsset,
        versionGroupId,
        version,
        parentFileId: parentFile?.id,
      };
      const duplicate = findDuplicate(index, input.task.userId, hash, fileAsset.id);
      if (duplicate) {
        fileAsset = { ...fileAsset, duplicateOfFileId: duplicate.id };
      }
      upsertFile(index, fileAsset);
      recordActivity(index, {
        fileId: fileAsset.id,
        userId: fileAsset.userId,
        type: parentFile ? 'version_created' : 'created',
        message: parentFile ? `AI 生成第 ${version} 版文件` : 'AI 生成文件',
        metadata: { taskId: input.task.id, artifactId: input.artifactId, parentFileId: parentFile?.id },
      });
      writeIndex(indexPath, index);
    });

    return fileAsset;
  }

  function createUploadedFile(input: CreateUploadedFileInput) {
    const parentLookup = input.parentFileId ? getEditableFile(input.userId, input.parentFileId) : undefined;
    if (input.parentFileId && !parentLookup) return undefined;
    const ownerUserId = parentLookup?.ownerId ?? input.userId;
    const { agent, logicalWorkspace, root, indexPath } = getWorkspaceInfo(ownerUserId, input.task);
    const extension = inferExtension({
      category: input.category,
      fileName: input.name,
      mimeType: input.mimeType,
    });
    const mimeType = input.mimeType ?? mimeByExtension[extension] ?? 'application/octet-stream';
    const category = inferCategory({
      category: input.category,
      fileName: input.name,
      mimeType,
    });
    const originalStem = input.name.replace(/\.[^.]+$/, '');
    const nameStem = safeFileStem(originalStem || input.title || 'uploaded-file');
    const fileId = `file_${randomUUID()}`;
    const name = buildStoredFileName(fileId, nameStem, extension);
    const relativePath = ['xuanzhi', 'files', categoryFolders[category], name].join('/');
    const absolutePath = join(root, relativePath);
    const buffer = uploadedContentToBuffer(input);
    const hash = contentHash(buffer);
    const createdAt = nowIso();
    let fileAsset: FileAsset | undefined;
    withIndexLock(indexPath, () => {
      const index = readIndex(indexPath);
      const parentFile = input.parentFileId
        ? index.files.find((file) => file.id === input.parentFileId)
        : undefined;
      if (input.parentFileId && !parentFile) return;
      if (!folderExists(index, ownerUserId, input.folderId ?? parentFile?.folderId)) return;

      const versionGroupId = parentFile?.versionGroupId ?? parentFile?.id ?? fileId;
      const version = parentFile ? nextVersion(index, versionGroupId) : 1;

      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, buffer);

      const stat = statSync(absolutePath);
      fileAsset = {
        id: fileId,
        userId: ownerUserId,
        taskId: input.task?.id,
        agentId: agent?.id ?? input.task?.agentId,
        versionGroupId,
        version,
        parentFileId: parentFile?.id,
        folderId: input.folderId ?? parentFile?.folderId,
        name,
        title: input.title?.trim() || originalStem || input.name,
        category,
        source: 'user_uploaded',
        mimeType,
        extension: extension.replace(/^\./, ''),
        sizeBytes: stat.size,
        contentHash: hash,
        duplicateOfFileId: findDuplicate(index, ownerUserId, hash, fileId)?.id,
        path: relativePath,
        workspacePath: `${logicalWorkspace.replace(/\/+$/, '')}/${relativePath}`,
        summary: input.summary,
        previewText: previewFromBuffer(buffer, mimeType),
        tags: input.tags,
        createdAt,
        updatedAt: createdAt,
      };

      upsertFile(index, fileAsset);
      recordActivity(index, {
        fileId: fileAsset.id,
        userId: input.userId,
        type: parentFile ? 'version_created' : 'uploaded',
        message: parentFile ? `上传为第 ${version} 版` : '用户上传文件',
        metadata: { parentFileId: parentFile?.id },
      });
      writeIndex(indexPath, index);
    });

    return fileAsset;
  }

  function readFileContentInternal(
    userId: string,
    fileId: string,
    options: { recordPreview?: boolean } = { recordPreview: true },
  ): FileAssetContent | undefined {
    const lookup = getAccessibleFile(userId, fileId);
    if (!lookup) return undefined;
    const result = {
      file: enrichFile(lookup.index, lookup.file, { includePermissions: lookup.ownerId === userId }),
      absolutePath: join(lookup.root, lookup.file.path),
    };
    if (!result || !existsSync(result.absolutePath)) return undefined;
    if (options.recordPreview) {
      withIndexLock(lookup.indexPath, () => {
        const index = readIndex(lookup.indexPath);
        if (!index.files.some((file) => file.id === fileId && canReadFile(index, file, userId) && canReturnFileToUser(file, userId))) return;
        recordActivity(index, {
          fileId,
          userId,
          type: 'previewed',
          message: '预览文件',
        });
        writeIndex(lookup.indexPath, index);
      });
    }

    return readFilePreview(result.file, result.absolutePath);
  }

  function readFileContent(userId: string, fileId: string): FileAssetContent | undefined {
    return readFileContentInternal(userId, fileId, { recordPreview: true });
  }

  function recordDownload(userId: string, fileId: string) {
    const lookup = getAccessibleFile(userId, fileId);
    if (!lookup) return;
    withIndexLock(lookup.indexPath, () => {
      const index = readIndex(lookup.indexPath);
      if (!index.files.some((file) => file.id === fileId && canReadFile(index, file, userId) && canReturnFileToUser(file, userId))) return;
      recordActivity(index, {
        fileId,
        userId,
        type: 'downloaded',
        message: '下载文件',
      });
      writeIndex(lookup.indexPath, index);
    });
  }

  function recordUsedInChat(userId: string, fileIds: string[], taskId: string) {
    fileIds.forEach((fileId) => {
      const lookup = getAccessibleFile(userId, fileId);
      if (!lookup || lookup.file.deletedAt) return;
      withIndexLock(lookup.indexPath, () => {
        const index = readIndex(lookup.indexPath);
        if (!index.files.some((file) => file.id === fileId && canReadFile(index, file, userId) && canReturnFileToUser(file, userId))) return;
        recordActivity(index, {
          fileId,
          userId,
          type: 'used_in_chat',
          message: '加入对话上下文',
          metadata: { taskId, usedBy: userId, ownerId: lookup.ownerId },
        });
        writeIndex(lookup.indexPath, index);
      });
    });
  }

  function buildContextText(userId: string, fileIds: string[]) {
    let remainingChars = maxContextTextChars;
    return fileIds.flatMap((fileId) => {
      if (remainingChars <= 0) return [];
      const content = readFileContentInternal(userId, fileId, { recordPreview: false });
      if (!content) return [];
      if (content.kind === 'text') {
        const header = `[文件: ${content.file.name}]\n路径: ${content.file.workspacePath}\n内容:\n`;
        const body = content.text.slice(0, Math.min(6000, Math.max(0, remainingChars - header.length)));
        const entry = `${header}${body}`;
        remainingChars -= entry.length;
        return [entry];
      }
      const entry = `[文件: ${content.file.name}]\n路径: ${content.file.workspacePath}\n类型: ${content.file.mimeType}\n该文件无法直接作为文本展开。`;
      remainingChars -= entry.length;
      return [entry];
    }).join('\n\n---\n\n');
  }

  function validateContextFileIds(userId: string, fileIds: string[]) {
    const uniqueIds = [...new Set(fileIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length > maxContextFiles) {
      return { ok: false as const, message: `单次最多引用 ${maxContextFiles} 个文件` };
    }
    const invalidId = uniqueIds.find((fileId) => !getAccessibleFile(userId, fileId));
    if (invalidId) {
      return { ok: false as const, message: `文件不存在或无权访问：${invalidId}` };
    }
    return { ok: true as const, fileIds: uniqueIds };
  }

  function updateFile(userId: string, fileId: string, input: FileAssetUpdateInput) {
    const lookup = getEditableFile(userId, fileId);
    if (!lookup) return undefined;
    let updated: FileAsset | undefined;
    withIndexLock(lookup.indexPath, () => {
      const index = readIndex(lookup.indexPath);
      if (!folderExists(index, lookup.ownerId, input.folderId)) return;
      index.files = index.files.map((file) => {
        if (file.id !== fileId) return file;
        updated = {
          ...file,
          title: input.title ?? file.title,
          summary: input.summary ?? file.summary,
          folderId: input.folderId === null ? undefined : input.folderId ?? file.folderId,
          tags: input.tags ?? file.tags,
          isFavorite: input.isFavorite ?? file.isFavorite,
          updatedAt: nowIso(),
        };
        return updated;
      });
      if (updated) {
        recordActivity(index, {
          fileId,
          userId,
          type: 'updated',
          message: '更新文件信息',
        });
      }
      writeIndex(lookup.indexPath, index);
    });
    return updated ? getFile(userId, updated.id)?.file : undefined;
  }

  function deleteFile(userId: string, fileId: string) {
    let updated: FileAsset | undefined;
    writeUserIndex(userId, (index) => {
      index.files = index.files.map((file) => {
        if (file.userId !== userId || file.id !== fileId) return file;
        updated = { ...file, deletedAt: nowIso(), deletedBy: userId, updatedAt: nowIso() };
        return updated;
      });
      if (updated) {
        index.permissions = (index.permissions ?? []).map((permission) => (
          (permission.fileId === fileId || permission.versionGroupId === updated!.versionGroupId)
          && permission.principalType === 'public_link'
          && !permission.revokedAt
            ? { ...permission, revokedAt: nowIso(), updatedAt: nowIso() }
            : permission
        ));
        recordActivity(index, {
          fileId,
          userId,
          type: 'deleted',
          message: '移入回收站并撤销公开链接',
        });
      }
    });
    return updated ? getFile(userId, updated.id)?.file : undefined;
  }

  function restoreFile(userId: string, fileId: string) {
    let updated: FileAsset | undefined;
    writeUserIndex(userId, (index) => {
      index.files = index.files.map((file) => {
        if (file.userId !== userId || file.id !== fileId) return file;
        const { deletedAt: _deletedAt, deletedBy: _deletedBy, ...rest } = file;
        updated = { ...rest, updatedAt: nowIso() };
        return updated;
      });
      if (updated) {
        recordActivity(index, {
          fileId,
          userId,
          type: 'restored',
          message: '从回收站恢复',
        });
      }
    });
    return updated ? getFile(userId, updated.id)?.file : undefined;
  }

  function batchFiles(userId: string, input: FileBatchActionInput) {
    if (input.action === 'move') {
      const { indexPath } = getWorkspaceInfo(userId);
      const index = readIndex(indexPath);
      if (!folderExists(index, userId, input.folderId)) return [];
    }
    return input.fileIds
      .map((fileId) => {
        if (input.action === 'delete') return deleteFile(userId, fileId);
        if (input.action === 'restore') return restoreFile(userId, fileId);
        if (input.action === 'favorite') return updateFile(userId, fileId, { isFavorite: true });
        if (input.action === 'unfavorite') return updateFile(userId, fileId, { isFavorite: false });
        return updateFile(userId, fileId, { folderId: input.folderId ?? null });
      })
      .filter((file): file is FileAsset => Boolean(file));
  }

  function listFolders(userId: string) {
    const { indexPath } = getWorkspaceInfo(userId);
    return (readIndex(indexPath).folders ?? [])
      .filter((folder) => folder.userId === userId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  function createFolder(userId: string, input: { name: string; parentFolderId?: string }) {
    const { indexPath } = getWorkspaceInfo(userId);
    let folder: FileFolder | undefined;
    withIndexLock(indexPath, () => {
      const index = readIndex(indexPath);
      if (!folderExists(index, userId, input.parentFolderId)) return;
      folder = {
        id: `folder_${randomUUID()}`,
        userId,
        name: input.name.trim(),
        parentFolderId: input.parentFolderId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      index.folders = [folder, ...(index.folders ?? [])];
      writeIndex(indexPath, index);
    });
    return folder;
  }

  function updateFolder(userId: string, folderId: string, input: FileFolderUpdateInput) {
    let updated: FileFolder | undefined;
    writeUserIndex(userId, (index) => {
      const nextParentFolderId = input.parentFolderId === null ? undefined : input.parentFolderId;
      if (nextParentFolderId === folderId || !folderExists(index, userId, nextParentFolderId)) return;
      if (wouldCreateFolderCycle(index, folderId, nextParentFolderId)) return;
      index.folders = (index.folders ?? []).map((folder) => {
        if (folder.userId !== userId || folder.id !== folderId) return folder;
        updated = {
          ...folder,
          name: input.name?.trim() || folder.name,
          parentFolderId: input.parentFolderId === undefined ? folder.parentFolderId : nextParentFolderId,
          updatedAt: nowIso(),
        };
        return updated;
      });
    });
    return updated;
  }

  function deleteFolder(userId: string, folderId: string) {
    let deleted: FileFolder | undefined;
    writeUserIndex(userId, (index) => {
      deleted = (index.folders ?? []).find((folder) => folder.userId === userId && folder.id === folderId);
      if (!deleted) return;
      index.folders = (index.folders ?? [])
        .filter((folder) => folder.id !== folderId)
        .map((folder) => (
          folder.parentFolderId === folderId
            ? { ...folder, parentFolderId: undefined, updatedAt: nowIso() }
            : folder
        ));
      index.files = index.files.map((file) => (
        file.userId === userId && file.folderId === folderId
          ? { ...file, folderId: undefined, updatedAt: nowIso() }
          : file
      ));
    });
    return deleted;
  }

  function listActivities(userId: string, fileId: string) {
    const lookup = getAccessibleFile(userId, fileId);
    if (!lookup) return [];
    return (lookup.index.activities ?? [])
      .filter((activity) => activity.fileId === fileId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  function listVersions(userId: string, fileId: string) {
    const lookup = getAccessibleFile(userId, fileId);
    if (!lookup) return [];
    return lookup.index.files
      .filter((item) => item.versionGroupId === lookup.file.versionGroupId && canReadFile(lookup.index, item, userId))
      .filter((item) => canReturnFileToUser(item, userId))
      .map((item) => enrichFile(lookup.index, item, { includePermissions: lookup.ownerId === userId }))
      .sort((left, right) => right.version - left.version);
  }

  function shareFile(userId: string, fileId: string, input: {
    principalType: FilePermission['principalType'];
    principalId: string;
    role: FilePermissionRole;
    expiresAt?: string;
  }) {
    let permission: FilePermission | undefined;
    writeUserIndex(userId, (index) => {
      const targetFile = index.files.find((file) => file.userId === userId && file.id === fileId);
      if (!targetFile) return;
      if (input.principalType === 'user' && !store.getUserById(input.principalId)) return;
      const principalId = input.principalType === 'public_link'
        ? (index.permissions ?? []).find((item) => (
          (item.fileId === fileId || item.versionGroupId === targetFile.versionGroupId)
          && item.principalType === 'public_link'
          && !item.revokedAt
        ))?.principalId ?? `share_${randomUUID()}`
        : input.principalId;
      const existing = (index.permissions ?? []).find((item) => (
        (item.fileId === fileId || item.versionGroupId === targetFile.versionGroupId)
        && item.principalType === input.principalType
        && item.principalId === principalId
      ));
      if (existing) {
        permission = {
          ...existing,
          expiresAt: input.expiresAt,
          versionGroupId: targetFile.versionGroupId,
          role: input.role,
          revokedAt: undefined,
          updatedAt: nowIso(),
        };
        index.permissions = (index.permissions ?? []).map((item) => (
          item.id === existing.id ? permission! : item
        ));
      } else {
        permission = {
          id: `fperm_${randomUUID()}`,
          fileId,
          versionGroupId: targetFile.versionGroupId,
          principalType: input.principalType,
          principalId,
          role: input.role,
          expiresAt: input.expiresAt,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        index.permissions = [permission, ...(index.permissions ?? [])];
      }
      recordActivity(index, {
        fileId,
        userId,
        type: 'shared',
        message: `分享为 ${input.role}`,
        metadata: { ...input, versionGroupId: targetFile.versionGroupId },
      });
    });
    return permission;
  }

  function revokePermission(userId: string, fileId: string, permissionId: string) {
    let permission: FilePermission | undefined;
    writeUserIndex(userId, (index) => {
      if (!index.files.some((file) => file.userId === userId && file.id === fileId)) return;
      index.permissions = (index.permissions ?? []).map((item) => {
        if (item.id !== permissionId || item.fileId !== fileId) return item;
        permission = { ...item, revokedAt: nowIso(), updatedAt: nowIso() };
        return permission;
      });
      if (permission) {
        recordActivity(index, {
          fileId,
          userId,
          type: 'shared',
          message: '撤销分享',
          metadata: { permissionId },
        });
      }
    });
    return permission;
  }

  function getPublicFile(token: string) {
    const lookup = getPublicFileByToken(token);
    if (!lookup) return undefined;
    return {
      file: enrichFile(lookup.index, lookup.file),
      absolutePath: join(lookup.root, lookup.file.path),
    };
  }

  function recordPublicFileAccess(token: string, lookup: FileLookup, type: 'previewed' | 'downloaded', metadata?: unknown) {
    withIndexLock(lookup.indexPath, () => {
      const index = readIndex(lookup.indexPath);
      const activePermission = (index.permissions ?? []).find((item) => (
        (item.fileId === lookup.file.id || item.versionGroupId === lookup.file.versionGroupId)
        && item.principalType === 'public_link'
        && item.principalId === token
        && item.role === 'viewer'
        && !item.revokedAt
        && (!item.expiresAt || new Date(item.expiresAt).getTime() > Date.now())
      ));
      const activeFile = index.files.find((file) => file.id === lookup.file.id && !file.deletedAt);
      if (!activePermission || !activeFile) return;
      recordActivity(index, {
        fileId: lookup.file.id,
        userId: 'public',
        type,
        message: type === 'previewed' ? '公共链接预览文件' : '公共链接下载文件',
        metadata: {
          access: 'public_link',
          token,
          ownerId: lookup.ownerId,
          permissionId: activePermission.id,
          ...(metadata && typeof metadata === 'object' ? metadata : {}),
        },
      });
      writeIndex(lookup.indexPath, index);
    });
  }

  function readPublicFileContent(token: string, metadata?: unknown) {
    const lookup = getPublicFileByToken(token);
    if (!lookup) return undefined;
    const file = enrichFile(lookup.index, lookup.file);
    const absolutePath = join(lookup.root, lookup.file.path);
    const content = readFilePreview(file, absolutePath);
    if (content) {
      recordPublicFileAccess(token, lookup, 'previewed', metadata);
    }
    return content;
  }

  function recordPublicDownload(token: string, metadata?: unknown) {
    const lookup = getPublicFileByToken(token);
    if (!lookup) return;
    recordPublicFileAccess(token, lookup, 'downloaded', metadata);
  }

  return {
    batchFiles,
    buildContextText,
    createFolder,
    createFileFromArtifact,
    createUploadedFile,
    deleteFile,
    getFile,
    listActivities,
    listFolders,
    listFilesPage,
    readFileContent,
    recordPublicDownload,
    recordDownload,
    recordUsedInChat,
    restoreFile,
    revokePermission,
    shareFile,
    updateFile,
    updateFolder,
    validateContextFileIds,
    deleteFolder,
    getPublicFile,
    readPublicFileContent,
    listVersions,
    listFiles,
  };
}

export type FileAssetService = ReturnType<typeof createFileAssetService>;
