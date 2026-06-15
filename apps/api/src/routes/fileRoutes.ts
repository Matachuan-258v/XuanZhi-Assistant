import { createReadStream, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, isAbsolute, posix, resolve, sep } from 'node:path';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  FileAssetCategory,
  FileAssetSource,
  FileAssetUpdateInput,
  FileAssetUploadInput,
  FileBatchActionInput,
  FileFolderUpdateInput,
  FilePermissionRole,
} from '@xuanzhi/shared/protocol';

import type { AppDependencies } from '../app/dependencies.js';
import { createXuanzhiWorkspacePath } from '../agents/workspace.js';
import { requireOwnedTask, requireUserAuth } from '../http/taskGuards.js';

type ResolvedWorkspaceFile = {
  filePath: string;
  logicalPath: string;
};

const categories = new Set<FileAssetCategory>([
  'documents',
  'spreadsheets',
  'images',
  'presentations',
  'reports',
  'code',
  'data',
  'others',
]);

const sources = new Set<FileAssetSource>([
  'assistant_generated',
  'tool_output',
  'user_uploaded',
  'workspace_imported',
]);

const permissionRoles = new Set<FilePermissionRole>(['viewer', 'editor']);
const uploadSizeLimitBytes = 25 * 1024 * 1024;

function openWithSystemApp(absolutePath: string) {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', absolutePath]
    : [absolutePath];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function revealInSystemApp(absolutePath: string) {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'explorer'
      : 'xdg-open';
  const args = process.platform === 'darwin'
    ? ['-R', absolutePath]
    : process.platform === 'win32'
      ? ['/select,', absolutePath]
      : [dirname(absolutePath)];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function normalizeCategory(value: unknown) {
  return typeof value === 'string' && categories.has(value as FileAssetCategory)
    ? (value as FileAssetCategory)
    : undefined;
}

function normalizeSource(value: unknown) {
  return typeof value === 'string' && sources.has(value as FileAssetSource)
    ? (value as FileAssetSource)
    : undefined;
}

function isUploadEncoding(value: unknown) {
  return value === undefined || value === 'text' || value === 'base64';
}

function isBatchAction(value: unknown): value is FileBatchActionInput['action'] {
  return value === 'delete'
    || value === 'restore'
    || value === 'favorite'
    || value === 'unfavorite'
    || value === 'move';
}

function isBase64(value: string) {
  return /^[a-zA-Z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;
}

function estimateUploadSizeBytes(input: Pick<FileAssetUploadInput, 'content' | 'encoding'>) {
  return input.encoding === 'base64'
    ? Math.ceil(input.content.length * 0.75)
    : Buffer.byteLength(input.content, 'utf8');
}

function userFolderExists(dependencies: AppDependencies, userId: string, folderId: string | undefined | null) {
  if (!folderId) return true;
  return dependencies.services.files.listFolders(userId).some((folder) => folder.id === folderId);
}

function accessMetadata(request: FastifyRequest) {
  return {
    ip: request.ip,
    referrer: request.headers.referer,
    userAgent: request.headers['user-agent'],
  };
}

const workspaceMimeTypes: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

function isWindowsPath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function isInside(parent: string, target: string) {
  return target === parent || target.startsWith(`${parent}${sep}`);
}

function normalizePosixPath(value: string) {
  return value.replace(/\\/g, '/');
}

function isInsidePosix(parent: string, target: string) {
  return target === parent || target.startsWith(`${parent}/`);
}

function detectWslDistroName() {
  const cwdMatch = process.cwd().match(/^\\\\wsl(?:\.localhost)?\\([^\\]+)/i);
  return process.env.WSL_DISTRO_NAME || cwdMatch?.[1] || 'ubuntu';
}

function wslUncPath(posixPath: string) {
  return `\\\\wsl.localhost\\${detectWslDistroName()}${posixPath.replace(/\//g, '\\')}`;
}

function toLogicalPath(requestedPath: string) {
  const trimmed = requestedPath.trim();
  const uncMatch = trimmed.match(/^\\\\wsl(?:\.localhost)?\\[^\\]+\\(.+)$/i);
  if (uncMatch?.[1]) {
    return `/${uncMatch[1].replace(/\\/g, '/')}`;
  }
  return normalizePosixPath(trimmed);
}

function findExistingFile(candidates: string[]) {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const stat = statSync(candidate);
    if (stat.isFile()) {
      return candidate;
    }
  }
  return undefined;
}

function resolveWorkspaceFile(workspace: string, requestedPath: string): ResolvedWorkspaceFile | undefined {
  if (isWindowsPath(workspace)) {
    const workspaceRoot = resolve(workspace);
    const targetPath = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(workspaceRoot, requestedPath);

    if (!isInside(workspaceRoot, targetPath)) {
      return undefined;
    }

    const filePath = findExistingFile([targetPath]);
    return filePath ? { filePath, logicalPath: targetPath } : undefined;
  }

  const workspaceRoot = posix.normalize(normalizePosixPath(workspace));
  const logicalRequest = toLogicalPath(requestedPath);
  const logicalTarget = posix.isAbsolute(logicalRequest)
    ? posix.normalize(logicalRequest)
    : posix.normalize(posix.join(workspaceRoot, logicalRequest));

  if (!isInsidePosix(workspaceRoot, logicalTarget)) {
    return undefined;
  }

  const candidates = process.platform === 'win32'
    ? [logicalTarget, wslUncPath(logicalTarget)]
    : [logicalTarget];
  const filePath = findExistingFile(candidates);
  return filePath ? { filePath, logicalPath: logicalTarget } : undefined;
}

function contentTypeFor(filePath: string) {
  return workspaceMimeTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function canRenderInline(contentType: string) {
  return contentType.startsWith('image/');
}

function contentDisposition(disposition: 'attachment' | 'inline', filename: string) {
  const fallback = filename.replace(/[^\w.-]+/g, '_') || 'download';
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function getTaskWorkspace(task: { agentId?: string; userId: string }, dependencies: AppDependencies) {
  const agent = task.agentId
    ? dependencies.store.getAgent(task.agentId)
    : dependencies.store.getAgentByUserId(task.userId);
  if (agent?.workspace) {
    return agent.workspace;
  }

  const user = dependencies.store.getUserById(task.userId);
  return user ? createXuanzhiWorkspacePath(user.username) : undefined;
}

export function registerFileRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.addContentTypeParser(
    'application/octet-stream',
    { bodyLimit: uploadSizeLimitBytes, parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.post('/api/files/upload', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;

    const body = request.body as FileAssetUploadInput;
    const name = body.name?.trim();
    if (!name || typeof body.content !== 'string') {
      return reply.status(400).send({ message: '文件参数无效' });
    }
    if (!isUploadEncoding(body.encoding)) {
      return reply.status(400).send({ message: '文件编码无效' });
    }
    if (body.encoding === 'base64' && !isBase64(body.content)) {
      return reply.status(400).send({ message: 'base64 内容无效' });
    }
    if (body.category && !normalizeCategory(body.category)) {
      return reply.status(400).send({ message: '文件分类无效' });
    }
    if (estimateUploadSizeBytes(body) > uploadSizeLimitBytes) {
      return reply.status(413).send({ message: '文件超过 25MB 限制' });
    }
    if (!userFolderExists(dependencies, auth.user.id, body.folderId)) {
      return reply.status(400).send({ message: '文件夹不存在' });
    }

    let task;
    if (body.taskId) {
      task = dependencies.services.tasks.getOwnedTask(body.taskId, auth.user.id);
      if (!task) {
        return reply.status(404).send({ message: '任务不存在' });
      }
    }

    const file = dependencies.services.files.createUploadedFile({
      userId: auth.user.id,
      task,
      name,
      content: body.content,
      encoding: body.encoding,
      mimeType: body.mimeType,
      category: body.category,
      folderId: body.folderId,
      parentFileId: body.parentFileId,
      title: body.title,
      summary: body.summary,
      tags: body.tags,
    });
    if (!file) {
      return reply.status(404).send({ message: '父版本文件不存在或文件夹无效' });
    }
    return reply.status(201).send(file);
  });

  app.post('/api/files/upload-binary', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;

    const query = request.query as {
      category?: string;
      folderId?: string;
      mimeType?: string;
      name?: string;
      parentFileId?: string;
      summary?: string;
      tags?: string;
      taskId?: string;
      title?: string;
    };
    const buffer = Buffer.isBuffer(request.body) ? request.body : undefined;
    const name = query.name?.trim();
    if (!name || !buffer) {
      return reply.status(400).send({ message: '文件参数无效' });
    }
    if (buffer.byteLength > uploadSizeLimitBytes) {
      return reply.status(413).send({ message: '文件超过 25MB 限制' });
    }
    if (query.category && !normalizeCategory(query.category)) {
      return reply.status(400).send({ message: '文件分类无效' });
    }
    if (!userFolderExists(dependencies, auth.user.id, query.folderId)) {
      return reply.status(400).send({ message: '文件夹不存在' });
    }

    let task;
    if (query.taskId) {
      task = dependencies.services.tasks.getOwnedTask(query.taskId, auth.user.id);
      if (!task) {
        return reply.status(404).send({ message: '任务不存在' });
      }
    }

    const file = dependencies.services.files.createUploadedFile({
      userId: auth.user.id,
      task,
      name,
      buffer,
      mimeType: query.mimeType,
      category: normalizeCategory(query.category),
      folderId: query.folderId,
      parentFileId: query.parentFileId,
      title: query.title,
      summary: query.summary,
      tags: query.tags?.split(',').map((tag) => tag.trim()).filter(Boolean),
    });
    if (!file) {
      return reply.status(404).send({ message: '父版本文件不存在、无编辑权限或文件夹无效' });
    }
    return reply.status(201).send(file);
  });

  app.get('/api/file-folders', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;
    return dependencies.services.files.listFolders(auth.user.id);
  });

  app.post('/api/file-folders', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;
    const body = request.body as { name?: string; parentFolderId?: string };
    const name = body.name?.trim();
    if (!name) {
      return reply.status(400).send({ message: '文件夹名称不能为空' });
    }
    if (!userFolderExists(dependencies, auth.user.id, body.parentFolderId)) {
      return reply.status(400).send({ message: '父文件夹不存在' });
    }
    const folder = dependencies.services.files.createFolder(auth.user.id, {
      name,
      parentFolderId: body.parentFolderId,
    });
    if (!folder) {
      return reply.status(400).send({ message: '父文件夹不存在' });
    }
    return reply.status(201).send(folder);
  });

  app.patch('/api/file-folders/:folderId', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;
    const { folderId } = request.params as { folderId: string };
    const body = request.body as FileFolderUpdateInput;
    if (body.name !== undefined && !body.name.trim()) {
      return reply.status(400).send({ message: '文件夹名称不能为空' });
    }
    if (!userFolderExists(dependencies, auth.user.id, body.parentFolderId)) {
      return reply.status(400).send({ message: '父文件夹不存在' });
    }
    const folder = dependencies.services.files.updateFolder(auth.user.id, folderId, body);
    if (!folder) return reply.status(404).send({ message: '文件夹不存在' });
    return folder;
  });

  app.delete('/api/file-folders/:folderId', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;
    const { folderId } = request.params as { folderId: string };
    const folder = dependencies.services.files.deleteFolder(auth.user.id, folderId);
    if (!folder) return reply.status(404).send({ message: '文件夹不存在' });
    return reply.status(204).send();
  });

  app.post('/api/files/batch', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;
    const body = request.body as FileBatchActionInput;
    if (!Array.isArray(body.fileIds) || body.fileIds.length === 0) {
      return reply.status(400).send({ message: '请选择文件' });
    }
    if (!isBatchAction(body.action)) {
      return reply.status(400).send({ message: '批量操作无效' });
    }
    if (body.action === 'move' && !userFolderExists(dependencies, auth.user.id, body.folderId)) {
      return reply.status(400).send({ message: '目标文件夹不存在' });
    }
    return dependencies.services.files.batchFiles(auth.user.id, body);
  });

  app.get('/api/files', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;

    const query = request.query as {
      category?: string;
      deleted?: string;
      favorite?: string;
      folderId?: string;
      search?: string;
      source?: string;
      limit?: string;
      offset?: string;
      paged?: string;
    };
    if (query.category && !normalizeCategory(query.category)) {
      return reply.status(400).send({ message: '文件分类无效' });
    }
    if (query.source && !normalizeSource(query.source)) {
      return reply.status(400).send({ message: '文件来源无效' });
    }
    const filters = {
      category: normalizeCategory(query.category),
      deleted: query.deleted === 'true',
      favorite: query.favorite === 'true',
      folderId: query.folderId,
      search: query.search,
      source: normalizeSource(query.source),
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    };
    return query.paged === 'true'
      ? dependencies.services.files.listFilesPage(auth.user.id, filters)
      : dependencies.services.files.listFiles(auth.user.id, filters);
  });

  app.get('/api/files/:fileId', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;

    const { fileId } = request.params as { fileId: string };
    const result = dependencies.services.files.getFile(auth.user.id, fileId);
    if (!result) {
      return reply.status(404).send({ message: '文件不存在' });
    }
    return result.file;
  });

  app.patch('/api/files/:fileId', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;

    const { fileId } = request.params as { fileId: string };
    const body = request.body as FileAssetUpdateInput;
    if (!userFolderExists(dependencies, auth.user.id, body.folderId)) {
      return reply.status(400).send({ message: '目标文件夹不存在' });
    }
    const updated = dependencies.services.files.updateFile(
      auth.user.id,
      fileId,
      body,
    );
    if (!updated) {
      return reply.status(404).send({ message: '文件不存在' });
    }
    return updated;
  });

  app.post('/api/files/:fileId/delete', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;
    const { fileId } = request.params as { fileId: string };
    const updated = dependencies.services.files.deleteFile(auth.user.id, fileId);
    if (!updated) return reply.status(404).send({ message: '文件不存在' });
    return updated;
  });

  app.post('/api/files/:fileId/restore', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;
    const { fileId } = request.params as { fileId: string };
    const updated = dependencies.services.files.restoreFile(auth.user.id, fileId);
    if (!updated) return reply.status(404).send({ message: '文件不存在' });
    return updated;
  });

  app.post('/api/files/:fileId/open', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;
    const { fileId } = request.params as { fileId: string };
    const result = dependencies.services.files.getFile(auth.user.id, fileId);
    if (!result || !existsSync(result.absolutePath)) {
      return reply.status(404).send({ message: '文件不存在' });
    }
    try {
      openWithSystemApp(result.absolutePath);
      return { ok: true };
    } catch (error) {
      return reply.status(500).send({ message: error instanceof Error ? error.message : '打开文件失败' });
    }
  });

  app.post('/api/files/:fileId/reveal', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;
    const { fileId } = request.params as { fileId: string };
    const result = dependencies.services.files.getFile(auth.user.id, fileId);
    if (!result || !existsSync(result.absolutePath)) {
      return reply.status(404).send({ message: '文件不存在' });
    }
    try {
      revealInSystemApp(result.absolutePath);
      return { ok: true };
    } catch (error) {
      return reply.status(500).send({ message: error instanceof Error ? error.message : '打开文件位置失败' });
    }
  });

  app.get('/api/files/:fileId/activities', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;
    const { fileId } = request.params as { fileId: string };
    return dependencies.services.files.listActivities(auth.user.id, fileId);
  });

  app.get('/api/files/:fileId/versions', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;
    const { fileId } = request.params as { fileId: string };
    return dependencies.services.files.listVersions(auth.user.id, fileId);
  });

  app.post('/api/files/:fileId/share', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;
    const { fileId } = request.params as { fileId: string };
    const body = request.body as {
      principalType?: 'user' | 'team' | 'public_link';
      principalId?: string;
      role?: FilePermissionRole;
      expiresAt?: string;
    };
    if (!body.principalType || !body.principalId || !permissionRoles.has(body.role as FilePermissionRole)) {
      return reply.status(400).send({ message: '分享参数无效' });
    }
    if (body.principalType === 'team') {
      return reply.status(400).send({ message: '暂未接入团队权限' });
    }
    if (body.principalType === 'public_link' && body.role !== 'viewer') {
      return reply.status(400).send({ message: '公开链接仅支持只读权限' });
    }
    if (body.principalType === 'user' && !dependencies.store.getUserById(body.principalId)) {
      return reply.status(400).send({ message: '分享用户不存在' });
    }
    if (body.expiresAt !== undefined) {
      const expiresAt = new Date(body.expiresAt).getTime();
      if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
        return reply.status(400).send({ message: '分享过期时间无效' });
      }
    }
    const permission = dependencies.services.files.shareFile(auth.user.id, fileId, {
      principalType: body.principalType,
      principalId: body.principalId,
      role: body.role as FilePermissionRole,
      expiresAt: body.expiresAt,
    });
    if (!permission) return reply.status(404).send({ message: '文件不存在' });
    return reply.status(201).send(permission);
  });

  app.post('/api/files/:fileId/share/:permissionId/revoke', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;
    const { fileId, permissionId } = request.params as { fileId: string; permissionId: string };
    const permission = dependencies.services.files.revokePermission(auth.user.id, fileId, permissionId);
    if (!permission) return reply.status(404).send({ message: '分享记录不存在' });
    return permission;
  });

  app.get('/api/file-shares/:token/content', async (request, reply) => {
    const { token } = request.params as { token: string };
    const content = dependencies.services.files.readPublicFileContent(token, accessMetadata(request));
    if (!content) return reply.status(404).send({ message: '分享文件不存在或已失效' });
    return content;
  });

  app.get('/api/file-shares/:token/download', async (request, reply) => {
    const { token } = request.params as { token: string };
    const result = dependencies.services.files.getPublicFile(token);
    if (!result || !existsSync(result.absolutePath)) {
      return reply.status(404).send({ message: '分享文件不存在或已失效' });
    }
    reply.header('content-type', result.file.mimeType);
    reply.header('content-disposition', `attachment; filename="${encodeURIComponent(result.file.name)}"`);
    dependencies.services.files.recordPublicDownload(token, accessMetadata(request));
    return reply.send(createReadStream(result.absolutePath));
  });

  app.get('/api/files/:fileId/content', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;

    const { fileId } = request.params as { fileId: string };
    const content = dependencies.services.files.readFileContent(auth.user.id, fileId);
    if (!content) {
      return reply.status(404).send({ message: '文件不存在' });
    }
    return content;
  });

  app.get('/api/tasks/:taskId/file-assets', async (request, reply) => {
    const task = requireOwnedTask(request, reply, dependencies);
    if (!task) return;
    return dependencies.services.files.listFiles(task.userId, { taskId: task.id });
  });

  app.get('/api/tasks/:taskId/files', async (request, reply) => {
    const task = requireOwnedTask(request, reply, dependencies);
    if (!task) {
      return;
    }

    const query = request.query as { inline?: string; path?: string };
    const requestedPath = query.path?.trim();
    if (!requestedPath) {
      return reply.status(400).send({ message: '鏂囦欢璺緞涓嶈兘涓虹┖' });
    }

    const workspace = getTaskWorkspace(task, dependencies);
    if (!workspace) {
      return reply.status(404).send({ message: 'workspace 涓嶅瓨鍦?' });
    }

    const resolvedFile = resolveWorkspaceFile(workspace, requestedPath);
    if (!resolvedFile) {
      return reply.status(400).send({ message: '鏂囦欢涓嶅瓨鍦ㄦ垨璺緞鏃犳晥' });
    }

    const filename = basename(resolvedFile.logicalPath);
    const contentType = contentTypeFor(resolvedFile.filePath);
    const disposition = query.inline === '1' && canRenderInline(contentType) ? 'inline' : 'attachment';
    reply.header('content-type', contentType);
    reply.header('content-disposition', contentDisposition(disposition, filename));
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(createReadStream(resolvedFile.filePath));
  });

  app.get('/api/files/:fileId/download', async (request, reply) => {
    const auth = requireUserAuth(request, reply, dependencies);
    if (!auth) return;

    const { fileId } = request.params as { fileId: string };
    const query = request.query as { inline?: string };
    const result = dependencies.services.files.getFile(auth.user.id, fileId);
    if (!result || !existsSync(result.absolutePath)) {
      return reply.status(404).send({ message: '文件不存在' });
    }

    const disposition = query.inline === '1' && result.file.mimeType === 'application/pdf'
      ? 'inline'
      : 'attachment';
    reply.header('content-type', result.file.mimeType);
    reply.header('content-disposition', contentDisposition(disposition, result.file.name));
    reply.header('x-content-type-options', 'nosniff');
    dependencies.services.files.recordDownload(auth.user.id, fileId);
    return reply.send(createReadStream(result.absolutePath));
  });
}
