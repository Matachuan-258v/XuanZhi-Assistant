import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { Agent, AgentEventStatus, MessagePlanStep, MessageStatus, Task } from '@xuanzhi/shared/protocol';

import type { MemoryStore } from '../repositories/memoryStore.js';
import type { StreamHub } from '../realtime/streamHub.js';
import type { FileAssetService } from '../services/fileAssetService.js';
import { toolCallToPlanStep } from '../services/sessionService.js';
import type { SessionService } from '../services/sessionService.js';
import { getOpenClawClient } from './openclawClient.js';
import { syncAgentProfileFiles } from './profileFiles.js';
import { createXuanzhiWorkspacePath } from './workspace.js';

// ── Types ──

type ChatEventPayload = {
  runId: string;
  sessionKey?: string;
  session_key?: string;
  key?: string;
  seq: number;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }>;
  };
  errorMessage?: string;
  errorKind?: 'refusal' | 'timeout' | 'rate_limit' | 'context_length' | 'unknown';
};

type GatewayAgentEvent = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
  session_key?: string;
  key?: string;
};

type AgentHandle = {
  id: string;
  userId: string;
  name: string;
  gatewayAgentId: string | null;
  sessionKey: string;
  workspace: string;
  profile?: Agent['profile'];
  emoji?: string;
  model?: string;
};

const ASSISTANT_RESPONSE_TIMEOUT = 120_000;
const GENERATED_FILE_SCAN_LIMIT = 20;
const GENERATED_FILE_MAX_BYTES = 25 * 1024 * 1024;
const GENERATED_FILE_MTIME_SKEW_MS = 5_000;
const GENERATED_FILE_SKIP_DIRS = new Set(['.git', '.openclaw', '.xuanzhi', 'node_modules']);
const GENERATED_FILE_SKIP_NAMES = new Set([
  'AGENTS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'README.md',
  'SOUL.md',
  'USER.md',
  'xuanzhi-profile.json',
]);
const GENERATED_FILE_EXTENSIONS = new Set([
  'csv', 'diff', 'doc', 'docx', 'gif', 'html', 'jpeg', 'jpg', 'json', 'jsonl',
  'md', 'pdf', 'png', 'ppt', 'pptx', 'py', 'sql', 'svg', 'ts', 'tsx', 'txt',
  'webp', 'xls', 'xlsx', 'zip',
]);

type WorkspaceFileCandidate = {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
};

type WorkspaceFileSnapshot = Map<string, { sizeBytes: number; mtimeMs: number }>;

function eventSessionKey(payload: { sessionKey?: string; session_key?: string; key?: string }) {
  return payload.sessionKey ?? payload.session_key ?? payload.key;
}

function isDifferentSessionEvent(
  payload: { sessionKey?: string; session_key?: string; key?: string },
  expectedSessionKey: string,
) {
  const key = eventSessionKey(payload);
  return Boolean(key && key !== expectedSessionKey);
}

function uniqueSessionLabel(title: string, taskId: string) {
  return `${title} (${taskId.slice(-8)})`;
}

// ── Text merge (Gateway sends deltas, not full text) ──

function mergeStreamText(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming.startsWith(current)) return incoming;
  if (current.endsWith(incoming)) return current;
  const maxOverlap = Math.min(current.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (current.slice(-overlap) === incoming.slice(0, overlap)) {
      return current + incoming.slice(overlap);
    }
  }
  return current + incoming;
}

// ── Plan step helpers ──

function upsertStep(
  steps: MessagePlanStep[],
  text: string,
  status: MessagePlanStep['status'],
  stepId?: string,
): { steps: MessagePlanStep[]; id: string } {
  const id = stepId ?? `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const idx = steps.findIndex((s) => s.id === id);
  const step: MessagePlanStep = { id, text, status };
  if (idx >= 0) {
    const updated = [...steps];
    updated[idx] = step;
    return { steps: updated, id };
  }
  return { steps: [...steps, step], id };
}

function parseToolData(data: Record<string, unknown>): { id?: string; label: string; detail: string } {
  const id = (data.toolCallId ?? data.callId ?? data.tool_use_id ?? data.id) as string | undefined;
  const label = (data.toolName ?? data.name ?? data.function_name ?? data.tool ?? data.command ?? data.action) as string | undefined;
  const rawDetail = data.arguments ?? data.args ?? data.input ?? data.params ?? data.query ?? data.text ?? data.message ?? data.output ?? data.content ?? data.result ?? data.value ?? data.description ?? data.summary ?? data.title ?? data.path ?? data.url ?? data.file ?? data.pattern ?? data.keyword;
  const detail = typeof rawDetail === 'string'
    ? rawDetail
    : rawDetail && typeof rawDetail === 'object'
      ? JSON.stringify(rawDetail)
      : undefined;
  return {
    id: typeof id === 'string' ? id : undefined,
    label: typeof label === 'string' ? label.replace(/^[^:]+:/, '') : 'OpenClaw tool',
    detail: typeof detail === 'string' ? detail.slice(0, 200) : '',
  };
}

function isToolErrorData(data: Record<string, unknown>) {
  if (data.isError === true) return true;
  if (data.status === 'error' || data.state === 'error') return true;
  if (typeof data.error === 'string' && data.error.trim()) return true;
  if (typeof data.errorMessage === 'string' && data.errorMessage.trim()) return true;
  for (const key of ['result', 'output', 'content', 'message', 'data']) {
    const value = data[key];
    if (typeof value === 'string') {
      if (/"(?:status|state)"\s*:\s*"error"/i.test(value)) return true;
      if (/"(?:error|errorMessage)"\s*:\s*"[^"]+"/i.test(value)) return true;
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === 'object' && isToolErrorData(parsed as Record<string, unknown>)) {
          return true;
        }
      } catch {
        // Plain text result; regex checks above are enough.
      }
    }
    if (value && typeof value === 'object' && isToolErrorData(value as Record<string, unknown>)) {
      return true;
    }
  }
  return false;
}

function isRawToolPayloadText(text: string) {
  const value = text.trim();
  if (!value) return false;
  if (/<\/?(?:tool_call|function_call|tool_calls|function_calls)\b/i.test(value)) return true;
  if (/^(?:tool_use|tool_result|function_call|function_result|context\.compiled|trace\.metadata)\b/i.test(value)) return true;
  if (/^\{[\s\S]*"(?:tool_use|tool_result|tool_call|function_call|function_result|context\.compiled|trace\.metadata|toolCallId|toolName|function_name)"[\s\S]*\}$/i.test(value)) return true;
  return false;
}

function extractChatText(payload: ChatEventPayload): string | null {
  const text = (
    payload.message?.content
      ?.filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
      .trim() || null
  );
  return text && !isRawToolPayloadText(text) ? text : null;
}

function getAgentDisplayName(agent: AgentHandle) {
  return agent.profile?.agentName?.trim() || agent.name.trim() || agent.id;
}

function isImportableWorkspaceFile(relativePath: string) {
  const fileName = basename(relativePath);
  const extension = extname(fileName).slice(1).toLowerCase();
  return !GENERATED_FILE_SKIP_NAMES.has(fileName) && GENERATED_FILE_EXTENSIONS.has(extension);
}

async function resolveWorkspaceFile(workspace: string, mentionedPath: string) {
  const workspaceRoot = resolve(workspace);
  const absolutePath = resolve(workspaceRoot, mentionedPath);
  const relativePath = relative(workspaceRoot, absolutePath);
  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    return undefined;
  }
  try {
    const [realWorkspaceRoot, realAbsolutePath] = await Promise.all([
      realpath(workspaceRoot),
      realpath(absolutePath),
    ]);
    const realRelativePath = relative(realWorkspaceRoot, realAbsolutePath);
    if (
      !realRelativePath
      || realRelativePath === '..'
      || realRelativePath.startsWith(`..${sep}`)
      || isAbsolute(realRelativePath)
    ) {
      return undefined;
    }
    return { absolutePath: realAbsolutePath, relativePath };
  } catch {
    return undefined;
  }
}

async function listUpdatedWorkspaceFiles(
  workspace: string,
  sinceMs: number,
  limit = GENERATED_FILE_SCAN_LIMIT,
): Promise<WorkspaceFileCandidate[]> {
  const cutoff = sinceMs - GENERATED_FILE_MTIME_SKEW_MS;
  const candidates: WorkspaceFileCandidate[] = [];

  async function visit(directory: string): Promise<void> {
    if (candidates.length >= limit) return;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (candidates.length >= limit) return;
      if (entry.name.startsWith('.') || GENERATED_FILE_SKIP_DIRS.has(entry.name)) continue;

      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const fileStat = await stat(absolutePath);
        if (fileStat.size <= 0 || fileStat.size > GENERATED_FILE_MAX_BYTES || fileStat.mtimeMs < cutoff) continue;
        candidates.push({
          absolutePath,
          relativePath: relative(workspace, absolutePath),
          sizeBytes: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
        });
      } catch {
        // File may have disappeared while the agent was still writing.
      }
    }
  }

  await visit(workspace);
  return candidates
    .filter((candidate) => isImportableWorkspaceFile(candidate.relativePath))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit);
}

async function snapshotWorkspaceFiles(workspace: string | undefined): Promise<WorkspaceFileSnapshot> {
  const snapshot: WorkspaceFileSnapshot = new Map();
  if (!workspace) return snapshot;
  const workspaceRoot = workspace;

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || GENERATED_FILE_SKIP_DIRS.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const fileStat = await stat(absolutePath);
        const relativePath = relative(workspaceRoot, absolutePath);
        if (!isImportableWorkspaceFile(relativePath)) continue;
        snapshot.set(relativePath, { sizeBytes: fileStat.size, mtimeMs: fileStat.mtimeMs });
      } catch {
        // Ignore files that disappear during the snapshot.
      }
    }
  }

  await visit(workspaceRoot);
  return snapshot;
}

function hasChangedSinceSnapshot(candidate: WorkspaceFileCandidate, snapshot: WorkspaceFileSnapshot) {
  const previous = snapshot.get(candidate.relativePath);
  if (!previous) return true;
  return previous.sizeBytes !== candidate.sizeBytes || previous.mtimeMs !== candidate.mtimeMs;
}

function extractMentionedFilePaths(text: string | null | undefined) {
  if (!text) return [];

  const paths = new Set<string>();
  const pattern = /[`"“”']?((?:[\p{L}\p{N}._ -]+\/)*[\p{L}\p{N}._ -]+\.([a-zA-Z0-9]{1,8}))[`"“”']?/gu;
  for (const match of text.matchAll(pattern)) {
    const path = match[1]?.trim();
    const extension = match[2]?.toLowerCase();
    if (!path || !extension || !GENERATED_FILE_EXTENSIONS.has(extension)) continue;
    if (path.includes('://') || path.startsWith('/') || path.startsWith('..')) continue;
    if (!isImportableWorkspaceFile(path)) continue;
    paths.add(path);
  }
  return [...paths].slice(0, GENERATED_FILE_SCAN_LIMIT);
}

async function getMentionedWorkspaceFiles(workspace: string, responseText: string | null | undefined) {
  const candidates: WorkspaceFileCandidate[] = [];
  for (const mentionedPath of extractMentionedFilePaths(responseText)) {
    const resolvedFile = await resolveWorkspaceFile(workspace, mentionedPath);
    if (!resolvedFile || !isImportableWorkspaceFile(resolvedFile.relativePath)) continue;
    try {
      const fileStat = await stat(resolvedFile.absolutePath);
      if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > GENERATED_FILE_MAX_BYTES) continue;
      candidates.push({
        absolutePath: resolvedFile.absolutePath,
        relativePath: resolvedFile.relativePath,
        sizeBytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      });
    } catch {
      // The model may mention conceptual filenames that were not actually written.
    }
  }
  return candidates;
}

async function importGeneratedWorkspaceFiles(
  task: Task,
  agent: AgentHandle,
  fileService: FileAssetService | undefined,
  stream: StreamHub,
  sinceMs: number,
  baseline: WorkspaceFileSnapshot,
  responseText?: string | null,
) {
  if (!fileService || !agent.workspace) return [];

  const existingForTask = fileService.listFiles(task.userId, { taskId: task.id, includeAllVersions: true });
  const existingByPath = new Map<string, (typeof existingForTask)[number]>();
  for (const file of existingForTask) {
    const relativePath = file.summary?.match(/^OpenClaw workspace 文件: (.+)$/)?.[1];
    if (relativePath && !existingByPath.has(relativePath)) {
      existingByPath.set(relativePath, file);
    }
  }
  const imported = [];
  const candidatesByPath = new Map<string, WorkspaceFileCandidate>();

  for (const candidate of await getMentionedWorkspaceFiles(agent.workspace, responseText)) {
    if (!hasChangedSinceSnapshot(candidate, baseline)) continue;
    candidatesByPath.set(candidate.relativePath, candidate);
  }
  for (const candidate of await listUpdatedWorkspaceFiles(agent.workspace, sinceMs)) {
    if (!hasChangedSinceSnapshot(candidate, baseline)) continue;
    candidatesByPath.set(candidate.relativePath, candidate);
  }

  for (const candidate of candidatesByPath.values()) {
    const fileName = basename(candidate.relativePath);
    const previousVersion = existingByPath.get(candidate.relativePath);

    try {
      const file = fileService.createFileFromArtifact({
        task,
        parentFileId: previousVersion?.id,
        title: fileName,
        fileName,
        content: await readFile(candidate.absolutePath),
        source: 'workspace_imported',
        summary: `OpenClaw workspace 文件: ${candidate.relativePath}`,
      });
      imported.push(file);
      existingByPath.set(candidate.relativePath, file);
      stream.broadcast(task.id, { type: 'file.asset.created', data: file });
    } catch (error) {
      console.warn('[OpenClawAgent] workspace file import skipped:', error instanceof Error ? error.message : String(error));
    }
  }

  return imported;
}

// ── Agent helpers factory ──

type AgentHelpers = ReturnType<typeof createAgentHelpers>;

async function syncProfileFilesSafely(
  client: ReturnType<typeof getOpenClawClient>,
  agent: AgentHandle,
  helpers: AgentHelpers,
) {
  if (!agent.gatewayAgentId) {
    return;
  }

  try {
    if (!agent.profile) {
      await client.request('agents.update', {
        agentId: agent.gatewayAgentId,
        name: getAgentDisplayName(agent),
        emoji: agent.emoji,
      });
      return;
    }
    await syncAgentProfileFiles(client, agent);
    helpers.publishEvent('agent.profile.synced', 'Agent 配置已同步到 OpenClaw', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agents] profile sync skipped:', message);
    helpers.publishEvent(
      'agent.profile.sync_skipped',
      'Agent 配置同步失败，已继续执行对话',
      'error',
      message,
    );
  }
}

function createAgentHelpers(task: Task, store: MemoryStore, stream: StreamHub) {
  const publishTaskStatus = (status: Task['status']) => {
    const updated = store.updateTaskStatus(task.id, status);
    if (updated) {
      stream.broadcast(task.id, { type: 'task.updated', data: updated });
    }
  };

  const publishEvent = (
    type: string,
    title: string,
    status: AgentEventStatus,
    message?: string,
  ) => {
    const event = store.addEvent({
      userId: task.userId,
      taskId: task.id,
      type,
      title,
      message,
      status,
    });
    stream.broadcast(task.id, { type: 'agent.event.created', data: event });
    return event;
  };

  return {
    publishTaskStatus,

    publishEvent,

    createStreamingMessage(parentMessageId?: string): string {
      const msg = store.addMessage({
        userId: task.userId,
        taskId: task.id,
        role: 'assistant',
        content: '',
        parentMessageId,
        status: 'streaming',
      });
      stream.broadcast(task.id, { type: 'message.created', data: msg });
      return msg.id;
    },

    updateStreamingMessage(messageId: string, content: string, planSteps?: MessagePlanStep[]): void {
      const updated = store.updateMessage(task.id, messageId, {
        content,
        status: 'streaming' as MessageStatus,
        planSteps,
      });
      if (updated) {
        stream.broadcast(task.id, { type: 'message.updated', data: updated });
      }
    },

    finalizeMessage(messageId: string, content: string, planSteps?: MessagePlanStep[]): void {
      const updated = store.updateMessage(task.id, messageId, {
        content,
        status: 'completed' as MessageStatus,
        planSteps,
      });
      if (updated) {
        stream.broadcast(task.id, { type: 'message.updated', data: updated });
      }
    },

    publishCompletedMessage(content: string) {
      const msg = store.addMessage({
        userId: task.userId,
        taskId: task.id,
        role: 'assistant',
        content,
        status: 'completed' as MessageStatus,
      });
      stream.broadcast(task.id, { type: 'message.created', data: msg });
      return msg;
    },
  };
}

// ── Gateway agent lifecycle ──

async function ensureGatewayAgent(
  client: ReturnType<typeof getOpenClawClient>,
  agent: AgentHandle,
  store: MemoryStore,
  helpers: AgentHelpers,
): Promise<string> {
  if (agent.gatewayAgentId) {
    await syncProfileFilesSafely(client, agent, helpers);
    return agent.gatewayAgentId;
  }

  // Fallback: search existing Gateway agents by agent.id (which is globally unique)
  try {
    const listResult = await client.request<{
      agents?: Array<{ id: string; name?: string; workspace?: string }>;
    }>('agents.list');
    const existing = listResult?.agents?.find((a) =>
      a.name === agent.id || a.workspace === agent.workspace,
    );
    if (existing?.id) {
      const updated = store.updateAgentGatewayInfo(agent.id, existing.id, existing.workspace ?? '');
      if (updated) {
        await syncProfileFilesSafely(client, updated, helpers);
      }
      helpers.publishEvent(
        'agent.found',
        `Gateway Agent 已存在: ${existing.id}`,
        'success',
      );
      return existing.id;
    }
  } catch {
    // list failed — fall through to create
  }

  helpers.publishEvent(
    'agent.create.starting',
    '正在创建 Gateway Agent',
    'running',
  );

  const owner = store.getUserById(agent.userId);
  const workspace = agent.workspace || createXuanzhiWorkspacePath(owner?.username ?? agent.userId);
  const displayName = getAgentDisplayName(agent);
  try {
    const created = await client.request<{
      ok: true;
      agentId: string;
      name: string;
      workspace: string;
    }>('agents.create', {
      name: displayName,
      workspace,
    });

    const updated = store.updateAgentGatewayInfo(agent.id, created.agentId, created.workspace);

    // Update display name
    if (updated?.profile) {
      await syncProfileFilesSafely(client, updated, helpers);
    } else {
      client.request('agents.update', {
        agentId: created.agentId,
        name: displayName,
      }).catch(() => {});
    }

    helpers.publishEvent(
      'agent.created',
      `Gateway Agent 已创建: ${created.agentId}`,
      'success',
    );
    return created.agentId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    helpers.publishEvent('agent.create.failed', 'Gateway Agent 创建失败', 'error', msg);
    throw err;
  }
}

async function ensureSession(
  client: ReturnType<typeof getOpenClawClient>,
  gatewayAgentId: string,
  store: MemoryStore,
  agent: AgentHandle,
  task: Task,
): Promise<{ key: string }> {
  if (task.sessionKey) {
    return { key: task.sessionKey };
  }

  // Create/reuse main session. Using key "main" — the Gateway resolves it to
  // "agent:{gatewayAgentId}:main" and returns the canonical key in the response.
  const mainResult = await client.request<{ key: string }>('sessions.create', {
    key: 'main',
    agentId: gatewayAgentId,
    label: `${getAgentDisplayName(agent)} 的主对话`,
  });

  // Task child session: linked to main via the canonical parentSessionKey
  // (must use the full "agent:{gatewayAgentId}:{rest}" format for lookup to work)
  const taskSessionKey = `task:${task.id}`;
  const session = await client.request<{ key: string }>('sessions.create', {
    key: taskSessionKey,
    agentId: gatewayAgentId,
    label: uniqueSessionLabel(task.title || task.userInput.slice(0, 50), task.id),
    parentSessionKey: mainResult.key,
  });
  store.updateTaskSessionKey(task.id, session.key);
  task.sessionKey = session.key;
  return session;
}

// ── Stream response with real-time delta forwarding + agent events ──

function streamResponse(
  client: ReturnType<typeof getOpenClawClient>,
  sessionKey: string,
  taskId: string,
  messageId: string,
  helpers: AgentHelpers,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let accumulatedText = '';
    let planSteps: MessagePlanStep[] = [];
    let stepCounter = 0;
    let finalizationTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      unsubChat();
      unsubAgent();
      if (finalizationTimer) clearTimeout(finalizationTimer);
      console.warn(`[OpenClawAgent] response timeout for task ${taskId}`);
      resolve(accumulatedText || null);
    }, ASSISTANT_RESPONSE_TIMEOUT);

    const broadcastSteps = () => {
      helpers.updateStreamingMessage(messageId, accumulatedText, planSteps);
    };

    const finalizeAfterToolDrain = () => {
      finalizationTimer = setTimeout(() => {
        unsubAgent();
        // Chat final can arrive just before the final tool_result event. After a
        // short drain window, close anything that did not receive an explicit error.
        if (planSteps.some((s) => s.status === 'running')) {
          planSteps = planSteps.map((s) =>
            s.status === 'running' ? { ...s, status: 'done' as const } : s,
          );
        }
        helpers.finalizeMessage(messageId, accumulatedText, planSteps);
        resolve(accumulatedText);
      }, 50);
    };

    // ── Chat stream (text deltas) ──

    const unsubChat = client.on<ChatEventPayload>('chat', (payload) => {
      if (isDifferentSessionEvent(payload, sessionKey)) return;

      if (payload.state === 'delta') {
        const text = extractChatText(payload);
        if (text) {
          accumulatedText = mergeStreamText(accumulatedText, text);
          helpers.updateStreamingMessage(messageId, accumulatedText, planSteps);
        }
        return;
      }

      if (payload.state === 'final') {
        clearTimeout(timer);
        unsubChat();
        const text = extractChatText(payload);
        if (text) accumulatedText = text;
        finalizeAfterToolDrain();
        return;
      }

      if (payload.state === 'aborted' || payload.state === 'error') {
        clearTimeout(timer);
        unsubChat();
        unsubAgent();
        if (finalizationTimer) clearTimeout(finalizationTimer);
        const reason = payload.errorMessage ?? `Agent ${payload.state}`;
        console.warn(`[OpenClawAgent] task ${taskId} ${payload.state}: ${reason}`);
        const text = extractChatText(payload);
        if (text) accumulatedText = text;
        helpers.finalizeMessage(messageId, accumulatedText, planSteps);
        resolve(accumulatedText);
      }
    });

    // ── Agent events (tool calls, reasoning, status) ──

    const unsubAgent = client.on<GatewayAgentEvent>('agent', (payload) => {
      if (isDifferentSessionEvent(payload, sessionKey)) return;

      const { stream, data } = payload;

      // "assistant" stream carries text chunks inside data — merge as regular text
      if (stream === 'assistant') {
        const text = extractRawText(data);
        if (text) {
          accumulatedText = mergeStreamText(accumulatedText, text);
          helpers.updateStreamingMessage(messageId, accumulatedText, planSteps);
        }
        return;
      }

      // Phase events (start/end)
      if ((data as { phase?: string }).phase === 'end') {
        planSteps = planSteps.map((s) =>
          s.status === 'running' ? { ...s, status: 'done' as const } : s,
        );
        broadcastSteps();
        return;
      }
      if ((data as { phase?: string }).phase === 'start') {
        const { label } = parseToolData(data);
        stepCounter++;
        const result = upsertStep(planSteps, label || '开始执行…', 'running', `phase-${stepCounter}`);
        planSteps = result.steps;
        broadcastSteps();
        return;
      }

      // Lifecycle / liveness — no visual step
      if (stream === 'lifecycle' || stream === 'liveness') return;

      // Tool call streams → create "running" step
      const toolStreams = new Set([
        'tool_call', 'tool_use', 'item', 'exec', 'process',
        'task', 'read', 'write', 'search', 'browse', 'agent',
      ]);
      if (toolStreams.has(stream)) {
        const { id, label, detail } = parseToolData(data);
        stepCounter++;
        const stepId = id || `tool-${stepCounter}`;
        const stepText = detail ? `${label}: ${detail}` : label;
        const result = upsertStep(planSteps, stepText, 'running', stepId);
        planSteps = result.steps;
        helpers.publishEvent('tool.started', label, 'running', detail);
        broadcastSteps();
        return;
      }

      // Tool result streams → mark matching step as "done"
      const resultStreams = new Set(['tool_result', 'command_output', 'output', 'result']);
      if (resultStreams.has(stream)) {
        const { id, label, detail } = parseToolData(data);
        const status = isToolErrorData(data) ? 'error' : 'done';
        if (id) {
          const idx = planSteps.findIndex((s) => s.id === id);
          if (idx >= 0) {
            planSteps[idx] = { ...planSteps[idx], status };
          }
        } else {
          // Mark most recent "running" step as done
          const lastRunning = [...planSteps].reverse().find((s) => s.status === 'running');
          if (lastRunning) {
            planSteps = planSteps.map((s) =>
              s.id === lastRunning.id ? { ...s, status } : s,
            );
          }
        }
        helpers.publishEvent(
          status === 'error' ? 'tool.error' : 'tool.completed',
          label || (status === 'error' ? '操作出错' : '操作完成'),
          status === 'error' ? 'error' : 'success',
          detail,
        );
        broadcastSteps();
        return;
      }

      // Reasoning / thinking — add as transient step
      if (stream === 'reasoning' || stream === 'think') {
        const text = (data.text ?? data.message ?? '') as string;
        if (text) {
          const shortText = typeof text === 'string' ? text.slice(0, 80) : String(text).slice(0, 80);
          stepCounter++;
          const result = upsertStep(planSteps, `思考: ${shortText}`, 'running', `think-${stepCounter}`);
          planSteps = result.steps;
          broadcastSteps();
        }
        return;
      }

      // Status update
      if (stream === 'status') {
        const text = (data.text ?? data.message ?? '') as string;
        if (text && typeof text === 'string') {
          stepCounter++;
          const result = upsertStep(planSteps, String(text).slice(0, 100), 'running', `status-${stepCounter}`);
          planSteps = result.steps;
          broadcastSteps();
        }
        return;
      }

      // Error
      if (stream === 'error') {
        const msg = (data.message ?? data.text ?? '执行出错') as string;
        stepCounter++;
        const result = upsertStep(planSteps, `✗ ${String(msg).slice(0, 150)}`, 'error', `error-${stepCounter}`);
        planSteps = result.steps;
        helpers.publishEvent('tool.error', '操作出错', 'error', String(msg).slice(0, 500));
        broadcastSteps();
        return;
      }

      // Fallback for unknown streams
      const { label, detail } = parseToolData(data);
      if (label && label !== '未知操作') {
        stepCounter++;
        const stepText = detail ? `${label}: ${detail}` : label;
        const result = upsertStep(planSteps, stepText, 'running', `generic-${stepCounter}`);
        planSteps = result.steps;
        broadcastSteps();
      }
    });
  });
}

function extractRawText(data: Record<string, unknown>): string | null {
  if (typeof data.text === 'string' && !isRawToolPayloadText(data.text)) return data.text;
  if (typeof data.content === 'string' && !isRawToolPayloadText(data.content)) return data.content;
  if (typeof data.message === 'string' && !isRawToolPayloadText(data.message)) return data.message;
  if (typeof data.delta === 'string' && !isRawToolPayloadText(data.delta)) return data.delta;
  if (data.message && typeof data.message === 'object') {
    const m = data.message as Record<string, unknown>;
    if (typeof m.content === 'string' && !isRawToolPayloadText(m.content)) return m.content;
    if (typeof m.text === 'string' && !isRawToolPayloadText(m.text)) return m.text;
  }
  return null;
}

async function applyDiskBackfillToMessage(input: {
  sessionService?: SessionService;
  gatewayAgentId: string;
  sessionKey: string;
  task: Task;
  store: MemoryStore;
  stream: StreamHub;
  messageId: string;
  userContent: string;
}) {
  const {
    sessionService,
    gatewayAgentId,
    sessionKey,
    task,
    store,
    stream,
    messageId,
    userContent,
  } = input;
  if (!sessionService) return;

  const normalizedUserContent = userContent.trim().replace(/\s+/g, ' ');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sessionId = sessionService.resolveSessionId(gatewayAgentId, sessionKey);
    if (sessionId) {
      const sessionMessages = sessionService.readSessionMessages(gatewayAgentId, sessionId);
      let userIndex = -1;
      for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
        const message = sessionMessages[index];
        if (
          message?.role === 'user'
          && message.content.trim().replace(/\s+/g, ' ') === normalizedUserContent
        ) {
          userIndex = index;
          break;
        }
      }

      const assistantMessage = userIndex >= 0
        ? sessionMessages.slice(userIndex + 1).find((message) => message.role === 'assistant')
        : undefined;
      if (assistantMessage?.toolCalls?.length) {
        const updated = store.updateMessage(task.id, messageId, {
          content: assistantMessage.content || undefined,
          status: 'completed' as MessageStatus,
          toolCalls: assistantMessage.toolCalls,
          planSteps: assistantMessage.toolCalls.map((toolCall) => toolCallToPlanStep(toolCall)),
        });
        if (updated) {
          stream.broadcast(task.id, { type: 'message.updated', data: updated });
        }
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

// ── Single entry point ──

export async function runOpenClawSession(
  task: Task,
  content: string,
  store: MemoryStore,
  stream: StreamHub,
  fileService?: FileAssetService,
  isFollowup = false,
  parentMessageId?: string,
  sessionService?: SessionService,
): Promise<void> {
  const client = getOpenClawClient();
  const agent = task.agentId ? store.getAgent(task.agentId) : store.getAgentByUserId(task.userId);
  if (!agent) {
    store.addEvent({
      userId: task.userId,
      taskId: task.id,
      type: 'agent.not_found',
      title: 'Agent 未找到',
      message: `用户 ${task.userId} 尚未配置 Agent`,
      status: 'error',
    });
    store.updateTaskStatus(task.id, 'failed');
    return;
  }

  const helpers = createAgentHelpers(task, store, stream);

  try {
    helpers.publishTaskStatus('running');
    store.updateAgentStatus(agent.id, 'running');
    const runStartedAt = Date.now();

    // 1. Ensure Gateway agent exists
    const gatewayAgentId = await ensureGatewayAgent(client, agent, store, helpers);

    // 2. Create/reuse main + task session on the Gateway
    const session = await ensureSession(client, gatewayAgentId, store, agent, task);
    const workspaceBaseline = await snapshotWorkspaceFiles(agent.workspace);

    // 3. Publish dispatch event
    if (isFollowup) {
      helpers.publishEvent(
        'task.followup.dispatched',
        '跟进消息已派发到 OpenClaw',
        'running',
        content,
      );
    } else {
      helpers.publishEvent(
        'task.dispatched',
        '任务已派发到 OpenClaw',
        'running',
        task.userInput,
      );
    }

    // 4. Send message to the Gateway agent
    const dispatchContent = content;
    const idempotencyKey = isFollowup
      ? `followup-${task.id}-${Date.now()}`
      : `task-${task.id}`;

    await client.request('chat.send', {
      sessionKey: session.key,
      idempotencyKey,
      message: dispatchContent,
    });

    helpers.publishEvent(
      'agent.execution.delivered',
      '任务已交付给 OpenClaw Agent',
      'success',
    );

    // 5. Stream the assistant response + agent events
    const messageId = helpers.createStreamingMessage(parentMessageId);
    const responseText = await streamResponse(client, session.key, task.id, messageId, helpers);
    await applyDiskBackfillToMessage({
      sessionService,
      gatewayAgentId,
      sessionKey: session.key,
      task,
      store,
      stream,
      messageId,
      userContent: content,
    });

    if (responseText) {
      helpers.publishEvent('agent.answer.created', 'Agent 已生成回复', 'success');
    }

    const importedFiles = await importGeneratedWorkspaceFiles(
      task,
      agent,
      fileService,
      stream,
      runStartedAt,
      workspaceBaseline,
      responseText,
    );
    if (importedFiles.length > 0) {
      helpers.publishEvent(
        'agent.files.imported',
        `已同步 ${importedFiles.length} 个文件到文件空间`,
        'success',
      );
    }

    helpers.publishTaskStatus('completed');
    store.updateAgentStatus(agent.id, 'idle');
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'OpenClaw 执行失败';

    helpers.publishEvent('agent.execution.failed', 'OpenClaw 执行失败', 'error', errMsg);
    helpers.publishTaskStatus('failed');
    store.updateAgentStatus(agent.id, 'error');
  }
}
