import { ApiError, apiUrl, authFetch } from './apiClient';
import { getAuthToken } from '../stores/authStore';

import type {
  FileActivity,
  FileAsset,
  FileAssetCategory,
  FileAssetContent,
  FileAssetSource,
  FileAssetUpdateInput,
  FileAssetUploadInput,
  FileBatchActionInput,
  FileFolder,
  FileFolderUpdateInput,
  FileListResult,
  FilePermission,
  FilePermissionRole,
} from '../types/protocol';

export function listFiles(filters: {
  category?: FileAssetCategory;
  deleted?: boolean;
  favorite?: boolean;
  folderId?: string;
  search?: string;
  source?: FileAssetSource;
  limit?: number;
  offset?: number;
} = {}) {
  const params = new URLSearchParams();
  if (filters.category) params.set('category', filters.category);
  if (filters.deleted) params.set('deleted', 'true');
  if (filters.favorite) params.set('favorite', 'true');
  if (filters.folderId) params.set('folderId', filters.folderId);
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  if (filters.source) params.set('source', filters.source);
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.offset) params.set('offset', String(filters.offset));
  const query = params.toString();
  return authFetch<FileAsset[]>(`/api/files${query ? `?${query}` : ''}`);
}

export function listFilesPage(filters: Parameters<typeof listFiles>[0] = {}) {
  const params = new URLSearchParams();
  if (filters.category) params.set('category', filters.category);
  if (filters.deleted) params.set('deleted', 'true');
  if (filters.favorite) params.set('favorite', 'true');
  if (filters.folderId) params.set('folderId', filters.folderId);
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  if (filters.source) params.set('source', filters.source);
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.offset) params.set('offset', String(filters.offset));
  params.set('paged', 'true');
  return authFetch<FileListResult>(`/api/files?${params.toString()}`);
}

export function listFolders() {
  return authFetch<FileFolder[]>('/api/file-folders');
}

export function createFolder(input: { name: string; parentFolderId?: string }) {
  return authFetch<FileFolder>('/api/file-folders', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateFolder(folderId: string, input: FileFolderUpdateInput) {
  return authFetch<FileFolder>(`/api/file-folders/${folderId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteFolder(folderId: string) {
  return authFetch<void>(`/api/file-folders/${folderId}`, { method: 'DELETE' });
}

export function listTaskFiles(taskId: string) {
  return authFetch<FileAsset[]>(`/api/tasks/${taskId}/file-assets`);
}

export function getFile(fileId: string) {
  return authFetch<FileAsset>(`/api/files/${fileId}`);
}

export function getFileContent(fileId: string) {
  return authFetch<FileAssetContent>(`/api/files/${fileId}/content`);
}

export function updateFile(fileId: string, input: FileAssetUpdateInput) {
  return authFetch<FileAsset>(`/api/files/${fileId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteFile(fileId: string) {
  return authFetch<FileAsset>(`/api/files/${fileId}/delete`, { method: 'POST' });
}

export function restoreFile(fileId: string) {
  return authFetch<FileAsset>(`/api/files/${fileId}/restore`, { method: 'POST' });
}

export function openFile(fileId: string) {
  return authFetch<{ ok: true }>(`/api/files/${fileId}/open`, { method: 'POST' });
}

export function revealFile(fileId: string) {
  return authFetch<{ ok: true }>(`/api/files/${fileId}/reveal`, { method: 'POST' });
}

export function listActivities(fileId: string) {
  return authFetch<FileActivity[]>(`/api/files/${fileId}/activities`);
}

export function listVersions(fileId: string) {
  return authFetch<FileAsset[]>(`/api/files/${fileId}/versions`);
}

export function shareFile(fileId: string, input: {
  principalType: 'user' | 'team' | 'public_link';
  principalId: string;
  role: FilePermissionRole;
  expiresAt?: string;
}) {
  return authFetch<FilePermission>(`/api/files/${fileId}/share`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function revokeShare(fileId: string, permissionId: string) {
  return authFetch<FilePermission>(`/api/files/${fileId}/share/${permissionId}/revoke`, {
    method: 'POST',
  });
}

export function batchFiles(input: FileBatchActionInput) {
  return authFetch<FileAsset[]>('/api/files/batch', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function uploadFile(input: FileAssetUploadInput) {
  return authFetch<FileAsset>('/api/files/upload', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function uploadBinaryFile(file: File, input: {
  category?: FileAssetCategory;
  folderId?: string;
  parentFileId?: string;
  summary?: string;
  tags?: string[];
  taskId?: string;
  title?: string;
} = {}) {
  const token = getAuthToken();
  const params = new URLSearchParams({
    mimeType: file.type || 'application/octet-stream',
    name: file.name,
  });
  if (input.category) params.set('category', input.category);
  if (input.folderId) params.set('folderId', input.folderId);
  if (input.parentFileId) params.set('parentFileId', input.parentFileId);
  if (input.summary) params.set('summary', input.summary);
  if (input.tags?.length) params.set('tags', input.tags.join(','));
  if (input.taskId) params.set('taskId', input.taskId);
  if (input.title) params.set('title', input.title);

  const response = await fetch(apiUrl(`/api/files/upload-binary?${params.toString()}`), {
    body: file,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/octet-stream',
    },
    method: 'POST',
  });
  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(text || response.statusText, response.status);
  }
  return response.json() as Promise<FileAsset>;
}

export function getFileDownloadUrl(fileId: string) {
  const token = getAuthToken();
  return apiUrl(`/api/files/${fileId}/download${token ? `?token=${encodeURIComponent(token)}` : ''}`);
}

export function getFileInlineUrl(fileId: string) {
  const token = getAuthToken();
  const params = new URLSearchParams({ inline: '1' });
  if (token) params.set('token', token);
  return apiUrl(`/api/files/${fileId}/download?${params.toString()}`);
}

export function getPublicFileDownloadUrl(shareToken: string) {
  return new URL(
    apiUrl(`/api/file-shares/${encodeURIComponent(shareToken)}/download`),
    window.location.origin,
  ).toString();
}
