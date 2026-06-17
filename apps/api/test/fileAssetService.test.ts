import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStore } from '../src/repositories/memoryStore.js';
import { createFileAssetService } from '../src/services/fileAssetService.js';

function makeTask(store: MemoryStore, userId = 'user_admin') {
  return store.createTask({
    userId,
    title: '文件空间测试',
    userInput: '验证文件空间',
    intent: 'general',
  });
}

describe('file asset service', () => {
  let previousFileRoot: string | undefined;
  let previousLockStaleMs: string | undefined;
  let tempRoot: string;
  let store: MemoryStore;
  let files: ReturnType<typeof createFileAssetService>;

  beforeEach(() => {
    previousFileRoot = process.env.XUANZHI_FILE_ROOT;
    previousLockStaleMs = process.env.XUANZHI_FILE_INDEX_LOCK_STALE_MS;
    tempRoot = mkdtempSync(join(tmpdir(), 'xuanzhi-files-'));
    process.env.XUANZHI_FILE_ROOT = tempRoot;
    process.env.XUANZHI_FILE_INDEX_LOCK_STALE_MS = '50';
    store = new MemoryStore();
    files = createFileAssetService(store);
  });

  afterEach(() => {
    if (previousFileRoot === undefined) delete process.env.XUANZHI_FILE_ROOT;
    else process.env.XUANZHI_FILE_ROOT = previousFileRoot;
    if (previousLockStaleMs === undefined) delete process.env.XUANZHI_FILE_INDEX_LOCK_STALE_MS;
    else process.env.XUANZHI_FILE_INDEX_LOCK_STALE_MS = previousLockStaleMs;
    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('records public preview and download as public activity', () => {
    const task = makeTask(store);
    const file = files.createFileFromArtifact({
      task,
      title: '公开报告',
      type: 'report',
      format: 'markdown',
      content: '# 公开报告',
    });
    const permission = files.shareFile('user_admin', file.id, {
      principalType: 'public_link',
      principalId: file.id,
      role: 'viewer',
    });

    expect(permission?.principalId).toMatch(/^share_/);
    expect(files.readPublicFileContent(permission!.principalId)?.kind).toBe('text');
    files.recordPublicDownload(permission!.principalId);

    const activities = files.listActivities('user_admin', file.id);
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'previewed', userId: 'public' }),
        expect.objectContaining({ type: 'downloaded', userId: 'public' }),
      ]),
    );
  });

  it('stores the source assistant message id for generated files', () => {
    const task = makeTask(store);
    const file = files.createFileFromArtifact({
      task,
      messageId: 'msg_assistant_1',
      title: '消息附件',
      type: 'report',
      format: 'markdown',
      content: '# 消息附件',
    });

    expect(file.messageId).toBe('msg_assistant_1');
    expect(files.listFiles(task.userId, { taskId: task.id })[0]?.messageId).toBe('msg_assistant_1');
  });

  it('does not expose deleted shared files to non-owners', () => {
    const task = makeTask(store);
    const file = files.createFileFromArtifact({
      task,
      title: '共享报告',
      type: 'report',
      format: 'markdown',
      content: '# 共享报告',
    });
    files.shareFile('user_admin', file.id, {
      principalType: 'user',
      principalId: 'user_b',
      role: 'viewer',
    });

    expect(files.getFile('user_b', file.id)?.file.id).toBe(file.id);
    files.deleteFile('user_admin', file.id);
    expect(files.getFile('user_b', file.id)).toBeUndefined();
    expect(files.listFiles('user_b')).toEqual([]);
  });

  it('returns bounded text previews for large text files', () => {
    const largeText = 'a'.repeat(2 * 1024 * 1024);
    const file = files.createUploadedFile({
      userId: 'user_admin',
      name: 'large.txt',
      content: largeText,
      encoding: 'text',
      mimeType: 'text/plain',
    });

    const content = files.readFileContent('user_admin', file!.id);
    expect(content?.kind).toBe('text');
    if (content?.kind === 'text') {
      expect(content.text).toHaveLength(1024 * 1024);
    }
  });

  it('classifies generated artifacts with QClaw-style file categories', () => {
    const task = makeTask(store);

    const markdownReport = files.createFileFromArtifact({
      task,
      title: 'Markdown 报告',
      type: 'report',
      format: 'markdown',
      content: '# Markdown 报告',
    });
    const pdf = files.createFileFromArtifact({
      task,
      title: 'PDF 报告',
      type: 'report',
      format: 'text',
      content: 'pdf placeholder',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
    });
    const json = files.createFileFromArtifact({
      task,
      title: 'JSON 数据',
      type: 'tool_result',
      format: 'json',
      content: { ok: true },
    });
    const diff = files.createFileFromArtifact({
      task,
      title: '代码变更',
      type: 'code_diff',
      format: 'diff',
      content: 'diff --git a/demo.ts b/demo.ts',
    });

    expect(markdownReport.category).toBe('documents');
    expect(markdownReport.path).toContain('/documents/');
    expect(pdf.category).toBe('reports');
    expect(pdf.path).toContain('/reports/');
    expect(json.category).toBe('code');
    expect(json.path).toContain('/code/');
    expect(diff.category).toBe('code');
    expect(diff.path).toContain('/code/');
  });

  it('keeps an active older version visible when a newer version is deleted', () => {
    const v1 = files.createUploadedFile({
      userId: 'user_admin',
      name: 'versioned.json',
      content: '{"version":1}',
      encoding: 'text',
      mimeType: 'application/json',
    });
    const v2 = files.createUploadedFile({
      userId: 'user_admin',
      name: 'versioned.json',
      content: '{"version":2}',
      encoding: 'text',
      mimeType: 'application/json',
      parentFileId: v1!.id,
    });

    files.deleteFile('user_admin', v2!.id);

    expect(files.listVersions('user_admin', v1!.id).map((file) => file.version)).toEqual([2, 1]);
    expect(files.listFiles('user_admin').some((file) => file.id === v1!.id)).toBe(true);
  });

  it('cleans stale index locks before writing', async () => {
    const indexPath = join(tempRoot, 'xuanzhi-user-user_admin', 'xuanzhi', 'index', 'files.manifest.json');
    const lockPath = `${indexPath}.lock`;
    mkdirSync(join(tempRoot, 'xuanzhi-user-user_admin', 'xuanzhi', 'index'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, createdAt: new Date(0).toISOString() }), 'utf8');
    const oldDate = new Date(Date.now() - 120_000);
    utimesSync(lockPath, oldDate, oldDate);

    const file = files.createUploadedFile({
      userId: 'user_admin',
      name: 'after-lock.txt',
      content: 'ok',
      encoding: 'text',
      mimeType: 'text/plain',
    });

    expect(file?.name).toContain('after-lock');
  });

  it('uses unique stored names and marks duplicate content', () => {
    const first = files.createUploadedFile({
      userId: 'user_admin',
      name: 'same.txt',
      content: 'same content',
      encoding: 'text',
      mimeType: 'text/plain',
    });
    const second = files.createUploadedFile({
      userId: 'user_admin',
      name: 'same.txt',
      content: 'same content',
      encoding: 'text',
      mimeType: 'text/plain',
    });

    expect(first?.path).not.toBe(second?.path);
    expect(first?.contentHash).toBe(second?.contentHash);
    expect(second?.duplicateOfFileId).toBe(first?.id);
  });

  it('shares an entire version group with editors', () => {
    const v1 = files.createUploadedFile({
      userId: 'user_admin',
      name: 'group.md',
      content: 'v1',
      encoding: 'text',
      mimeType: 'text/markdown',
    })!;
    files.shareFile('user_admin', v1.id, {
      principalType: 'user',
      principalId: 'user_b',
      role: 'editor',
    });
    const v2 = files.createUploadedFile({
      userId: 'user_b',
      name: 'group.md',
      content: 'v2',
      encoding: 'text',
      mimeType: 'text/markdown',
      parentFileId: v1.id,
    })!;

    expect(v2.userId).toBe('user_admin');
    expect(v2.versionGroupId).toBe(v1.versionGroupId);
    expect(files.listVersions('user_b', v1.id).map((file) => file.version)).toEqual([2, 1]);
  });

  it('revokes public links when a file is deleted', () => {
    const task = makeTask(store);
    const file = files.createFileFromArtifact({
      task,
      title: '待删除公开报告',
      type: 'report',
      format: 'markdown',
      content: '# 待删除',
    });
    const permission = files.shareFile('user_admin', file.id, {
      principalType: 'public_link',
      principalId: file.id,
      role: 'viewer',
    })!;
    expect(files.readPublicFileContent(permission.principalId)?.kind).toBe('text');

    files.deleteFile('user_admin', file.id);
    files.restoreFile('user_admin', file.id);

    expect(files.readPublicFileContent(permission.principalId)).toBeUndefined();
  });

  it('validates context file access and count', () => {
    const file = files.createUploadedFile({
      userId: 'user_admin',
      name: 'context.txt',
      content: 'context',
      encoding: 'text',
      mimeType: 'text/plain',
    })!;

    expect(files.validateContextFileIds('user_admin', [file.id, file.id])).toEqual({
      ok: true,
      fileIds: [file.id],
    });
    expect(files.validateContextFileIds('user_b', [file.id]).ok).toBe(false);
    expect(files.validateContextFileIds('user_admin', Array.from({ length: 11 }, (_, index) => `file_${index}`)).ok).toBe(false);
  });
});
