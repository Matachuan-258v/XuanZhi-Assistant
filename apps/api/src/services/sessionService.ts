import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MessagePlanStep, MessageToolCall, SessionInfo, SessionMessage } from '@xuanzhi/shared/protocol';

import { getOpenClawWorkspaceRoot } from '../agents/workspace.js';
import type { MemoryStore } from '../repositories/memoryStore.js';

// ── Path helpers ──

/**
 * Convert a Linux-style WSL path to a Windows UNC path that Node.js can read.
 * /home/<user>/.openclaw -> //wsl.localhost/<distro>/home/<user>/.openclaw
 *
 * Falls back to the original path when the translation doesn't apply (e.g.
 * running inside WSL directly, or the path is already a Windows path).
 */
function toWindowsWslPath(linuxPath: string): string {
  if (!linuxPath || linuxPath.startsWith('\\\\') || linuxPath.startsWith('//')) {
    return linuxPath;
  }

  // Only translate if we're on Windows and the path looks like a WSL Linux path.
  if (process.platform !== 'win32' || !linuxPath.startsWith('/')) {
    return linuxPath;
  }

  const distro = process.env.OPENCLAW_WSL_DISTRO?.trim()
    || process.env.WSL_DISTRO_NAME?.trim()
    || 'Ubuntu';

  return `//wsl.localhost/${distro}${linuxPath}`;
}

function getAgentsDir(): string {
  const root = getOpenClawWorkspaceRoot().replace(/\/+$/, '');
  const linuxPath = `${root}/agents`;
  return toWindowsWslPath(linuxPath);
}

function getSessionsDir(gatewayAgentId: string): string {
  return join(getAgentsDir(), gatewayAgentId, 'sessions');
}

// ── JSONL parsing ──

interface JsonlContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  partialArgs?: string;
}

interface JsonlMessage {
  type?: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };
  role?: string;
  content?: unknown;
}

interface JsonlTrajectoryEvent {
  type?: string;
  stream?: string;
  name?: string;
  toolName?: string;
  command?: string;
  data?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  message?: unknown;
  content?: unknown;
  output?: unknown;
  result?: unknown;
}

function safeReadText(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as JsonlContentBlock[])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
}

function stripRawToolPayloads(text: string) {
  return text
    .replace(/```(?:json|xml)?\s*[\r\n][\s\S]*?(?:"(?:tool_use|tool_result|tool_call|function_call|function_result|toolName|toolCallId|function_name)"|<\/?(?:tool_call|function_call|tool_calls|function_calls)\b)[\s\S]*?```/gi, '')
    .replace(/<(tool_call|function_call|tool_calls|function_calls)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:tool_call|function_call|tool_calls|function_calls)[^>]*>/gi, '')
    .split(/\r?\n/)
    .filter((line) => {
      const value = line.trim();
      if (!value) return true;
      if (/^(?:tool_use|tool_result|function_call|function_result|context\.compiled|trace\.metadata)\b/i.test(value)) return false;
      if (/^\{.*"(?:tool_use|tool_result|tool_call|function_call|function_result|toolName|toolCallId|function_name|arguments|args|params)"/i.test(value)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function normalizeRole(role: string | undefined): SessionMessage['role'] {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  return 'system';
}

function isToolOutputLine(line: string) {
  const value = line.trim();
  if (!value) return true;
  return (
    /^\/bin\/(?:bash|sh):\s/i.test(value)
    || /^\/usr\/bin\/python\d*(?::|\s*$)/i.test(value)
    || /^sudo:\s/i.test(value)
    || /^Successfully wrote \d+ bytes to\s+/i.test(value)
    || /^-[rwx-]{9}\s+\d+\s+\S+\s+\S+\s+\S+\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}\s+/i.test(value)
    || /\bcommand not found\b/i.test(value)
    || /\bNo module named\b/i.test(value)
  );
}

function stripToolOutputPrelude(text: string) {
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && isToolOutputLine(lines[index] ?? '')) {
    index += 1;
  }
  if (index === 0) return text.trim();
  return lines.slice(index).join('\n').trim();
}

function normalizeAssistantSessionText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const withoutPrelude = stripToolOutputPrelude(trimmed);
  if (!withoutPrelude) return '';

  const meaningfulLines = withoutPrelude.split(/\r?\n/).filter((line) => line.trim());
  if (meaningfulLines.length > 0 && meaningfulLines.every(isToolOutputLine)) {
    return '';
  }
  return withoutPrelude;
}

function readContentBlocks(content: unknown): JsonlContentBlock[] {
  return Array.isArray(content)
    ? content.filter((item): item is JsonlContentBlock => Boolean(item && typeof item === 'object'))
    : [];
}

function extractToolCalls(content: unknown): MessageToolCall[] {
  return readContentBlocks(content)
    .filter((item) => item.type === 'toolCall' && typeof item.id === 'string')
    .map((item) => ({
      id: item.id!,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'tool',
      arguments: item.arguments,
      status: 'running' as const,
    }));
}

function mergeToolCall(current: MessageToolCall[], next: MessageToolCall): MessageToolCall[] {
  const index = current.findIndex((item) => item.id === next.id);
  if (index < 0) return [...current, next];

  return current.map((item) => (
    item.id === next.id
      ? {
          ...item,
          ...next,
          arguments: next.arguments ?? item.arguments,
          result: next.result ?? item.result,
          isError: next.isError ?? item.isError,
        }
      : item
  ));
}

function attachToolResult(
  current: MessageToolCall[],
  result: { id: string; name?: string; content: string; isError?: boolean },
): MessageToolCall[] {
  const existing = current.find((item) => item.id === result.id);
  return mergeToolCall(current, {
    id: result.id,
    name: result.name || existing?.name || 'tool',
    arguments: existing?.arguments,
    result: result.content,
    isError: result.isError,
    status: result.isError ? 'error' : 'done',
  });
}

export function toolCallToPlanStep(toolCall: MessageToolCall): MessagePlanStep {
  const args = toolCall.arguments && typeof toolCall.arguments === 'object'
    ? toolCall.arguments as Record<string, unknown>
    : {};
  const path = typeof args.path === 'string' ? args.path.split(/[\\/]/).at(-1) : undefined;
  const command = typeof args.command === 'string' ? args.command : undefined;
  const text = command
    ? `${toolCall.name}: ${command}`
    : path
      ? `${toolCall.name}: ${path}`
      : toolCall.name;

  return {
    id: toolCall.id,
    text,
    status: toolCall.status === 'error' ? 'error' : toolCall.status === 'running' ? 'running' : 'done',
  };
}

function parseJsonlLine(line: string, index: number): SessionMessage | null {
  if (!line.trim()) return null;

  let raw: JsonlMessage;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }

  // Extract role and content from both top-level and nested message formats
  const role = raw.message?.role ?? raw.role;
  const content = raw.message?.content ?? raw.content;

  if (!role || !content) return null;

  const text = stripRawToolPayloads(extractTextContent(content));
  const normalizedRole = normalizeRole(role);
  const visibleText = normalizedRole === 'assistant'
    ? normalizeAssistantSessionText(text)
    : text.trim();
  if (!visibleText) return null;

  return {
    id: raw.id || `session-msg-${index}`,
    role: normalizedRole,
    content: visibleText,
    createdAt: raw.timestamp || new Date().toISOString(),
  };
}

export function parseOpenClawSessionMessages(text: string): SessionMessage[] {
  const messages: SessionMessage[] = [];
  let assistantTurn: SessionMessage | undefined;
  let lastUserMessageId: string | undefined;

  const flushAssistantTurn = () => {
    if (!assistantTurn) return;
    const toolCalls = assistantTurn.toolCalls?.map((toolCall) => (
      toolCall.status === 'running' ? { ...toolCall, status: 'done' as const } : toolCall
    ));
    if (assistantTurn.content.trim() || toolCalls?.length) {
      messages.push({
        ...assistantTurn,
        content: assistantTurn.content.trim(),
        toolCalls,
      });
    }
    assistantTurn = undefined;
  };

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;

    let raw: JsonlMessage;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    if (raw.type && raw.type !== 'message') continue;

    const role = raw.message?.role ?? raw.role;
    const content = raw.message?.content ?? raw.content;
    const createdAt = raw.timestamp || new Date().toISOString();

    if (role === 'user') {
      flushAssistantTurn();
      const userText = stripRawToolPayloads(extractTextContent(content));
      if (!userText.trim()) continue;
      const id = raw.id || `session-user-${index}`;
      messages.push({
        id,
        role: 'user',
        content: userText,
        parentMessageId: raw.parentId,
        createdAt,
      });
      lastUserMessageId = id;
      continue;
    }

    if (role === 'assistant') {
      const assistantText = normalizeAssistantSessionText(stripRawToolPayloads(extractTextContent(content)));
      const toolCalls = extractToolCalls(content);
      if (!assistantText.trim() && toolCalls.length === 0) continue;

      if (!assistantTurn) {
        assistantTurn = {
          id: raw.id || `session-assistant-${index}`,
          role: 'assistant',
          content: '',
          parentMessageId: raw.parentId ?? lastUserMessageId,
          createdAt,
          toolCalls: [],
        };
      }

      if (assistantText.trim()) {
        assistantTurn.content = [assistantTurn.content, assistantText].filter(Boolean).join('\n\n');
      }
      for (const toolCall of toolCalls) {
        assistantTurn.toolCalls = mergeToolCall(assistantTurn.toolCalls ?? [], toolCall);
      }
      continue;
    }

    if (role === 'toolResult') {
      const toolCallId = raw.message?.toolCallId;
      if (typeof toolCallId !== 'string' || !toolCallId) continue;

      if (!assistantTurn) {
        assistantTurn = {
          id: raw.parentId || raw.id || `session-assistant-${index}`,
          role: 'assistant',
          content: '',
          parentMessageId: raw.parentId ?? lastUserMessageId,
          createdAt,
          toolCalls: [],
        };
      }

      assistantTurn.toolCalls = attachToolResult(assistantTurn.toolCalls ?? [], {
        id: toolCallId,
        name: typeof raw.message?.toolName === 'string' ? raw.message.toolName : undefined,
        content: stripRawToolPayloads(extractTextContent(content)),
        isError: Boolean(raw.message?.isError),
      });
    }
  }

  flushAssistantTurn();
  return messages;
}

function stringifyCompact(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringifyCompact(value);
    if (text) return text;
  }
  return undefined;
}

function eventBag(event: JsonlTrajectoryEvent): Record<string, unknown> {
  return {
    ...(event.payload ?? {}),
    ...(event.data ?? {}),
    ...event,
  };
}

function eventName(event: JsonlTrajectoryEvent): string {
  const bag = eventBag(event);
  return firstString(event.stream, event.type, bag.event, bag.phase, bag.kind, bag.name, bag.toolName) ?? '';
}

function isNoisyTrajectoryEvent(name: string) {
  const normalized = name.toLowerCase();
  return !normalized
    || normalized.includes('session')
    || normalized.includes('context')
    || normalized.includes('metadata')
    || normalized.includes('heartbeat')
    || normalized.includes('liveness')
    || normalized.includes('token')
    || normalized.includes('model')
    || normalized.includes('thinking')
    || normalized.includes('reasoning');
}

function buildTrajectoryStep(event: JsonlTrajectoryEvent, index: number): MessagePlanStep | undefined {
  const name = eventName(event);
  if (isNoisyTrajectoryEvent(name)) return undefined;

  const bag = eventBag(event);
  const command = firstString(bag.command, bag.cmd, bag.shell, bag.argv);
  const path = firstString(bag.path, bag.file, bag.filename, bag.target);
  const tool = firstString(bag.toolName, bag.tool, bag.name, bag.function_name, bag.functionName);
  const haystack = [name, tool, command, path].filter(Boolean).join(' ').toLowerCase();
  const status: MessagePlanStep['status'] = haystack.includes('error') || haystack.includes('fail')
    ? 'error'
    : 'done';

  let text: string | undefined;
  if (haystack.includes('write') || haystack.includes('create') || haystack.includes('save')) {
    text = path ? `write ${path}` : 'write';
  } else if (haystack.includes('read') || haystack.includes('open')) {
    text = path ? `read ${path}` : 'read';
  } else if (haystack.includes('exec') || haystack.includes('command') || haystack.includes('shell') || command) {
    text = command ? `exec: ${command.slice(0, 160)}` : 'exec';
  } else if (haystack.includes('search') || haystack.includes('rg') || haystack.includes('grep')) {
    text = 'search';
  } else if (haystack.includes('edit') || haystack.includes('patch')) {
    text = path ? `edit ${path}` : 'edit';
  } else if (haystack.includes('install') || haystack.includes('pnpm') || haystack.includes('npm')) {
    text = command ? `install: ${command.slice(0, 160)}` : 'install';
  } else if (haystack.includes('test') || haystack.includes('vitest')) {
    text = command ? `test: ${command.slice(0, 160)}` : 'test';
  } else if (tool && /(tool|call|use|function)/i.test(name)) {
    text = `tool: ${tool.slice(0, 80)}`;
  }

  if (!text) return undefined;

  return {
    id: firstString(bag.id, bag.callId, bag.toolCallId) ?? `trajectory-step-${index}`,
    text,
    status,
  };
}

export function parseOpenClawTrajectorySteps(text: string): MessagePlanStep[] {
  const steps: MessagePlanStep[] = [];
  const seen = new Set<string>();

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event: JsonlTrajectoryEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const step = buildTrajectoryStep(event, index);
    if (!step) continue;
    const dedupeKey = `${step.id}:${step.text}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    steps.push(step);
  }

  return steps;
}

// ── Session info from sessions.json ──

interface DiskSessionEntry {
  sessionId?: string;
  sessionKey?: string;
  key?: string;
  status?: string;
  title?: string;
  name?: string;
  label?: string;
  totalTokens?: number;
  estimatedCostUsd?: number;
  runtimeMs?: number;
  modelProvider?: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  updatedAt?: number;
  sessionStartedAt?: number;
  parentSessionKey?: string;
  childSessions?: string[];
}

function sessionInfoFromDiskEntry(
  key: string,
  entry: DiskSessionEntry,
  agentId: string,
): SessionInfo {
  const updatedAt = entry.updatedAt || entry.sessionStartedAt || Date.now();
  const createdAt = entry.sessionStartedAt || entry.startedAt || updatedAt;
  const title =
    entry.title?.trim()
    || entry.name?.trim()
    || entry.label?.trim()
    || key.split(':').at(-1)
    || 'OpenClaw Session';

  return {
    sessionId: entry.sessionId || key,
    sessionKey: entry.key || key,
    agentId,
    title: title.slice(0, 80),
    status: entry.status || 'unknown',
    totalTokens: entry.totalTokens,
    estimatedCostUsd: entry.estimatedCostUsd,
    runtimeMs: entry.runtimeMs,
    modelProvider: entry.modelProvider,
    model: entry.model,
    startedAt:
      typeof entry.startedAt === 'number'
        ? new Date(entry.startedAt).toISOString()
        : undefined,
    endedAt:
      typeof entry.endedAt === 'number'
        ? new Date(entry.endedAt).toISOString()
        : undefined,
    parentSessionKey: entry.parentSessionKey,
    childSessions: entry.childSessions,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
  };
}

// ── Service ──

export function createSessionService(store: MemoryStore) {
  /**
   * Read the sessions.json index for a specific Gateway agent.
   * Returns parsed session metadata entries.
   */
  function readSessionsIndex(gatewayAgentId: string): SessionInfo[] {
    const dir = getSessionsDir(gatewayAgentId);
    const indexPath = join(dir, 'sessions.json');

    if (!existsSync(indexPath)) {
      return [];
    }

    let raw: Record<string, DiskSessionEntry>;
    try {
      raw = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch {
      return [];
    }

    if (!raw || typeof raw !== 'object') return [];

    return Object.entries(raw)
      .filter(([, entry]) => entry && typeof entry === 'object')
      .map(([key, entry]) => sessionInfoFromDiskEntry(key, entry, gatewayAgentId));
  }

  /**
   * Read session messages from a JSONL file on disk.
   */
  function readSessionMessages(
    gatewayAgentId: string,
    sessionId: string,
  ): SessionMessage[] {
    // Fast path: check MemoryStore first for active sessions
    const localMessages = store.listMessages(sessionId);
    if (localMessages.length > 0) {
      return localMessages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      }));
    }

    // Fallback: read JSONL from OpenClaw disk
    const dir = getSessionsDir(gatewayAgentId);
    const jsonlPath = join(dir, `${sessionId}.jsonl`);
    const text = safeReadText(jsonlPath);

    return text ? parseOpenClawSessionMessages(text) : [];
  }

  /**
   * Read the OpenClaw trajectory file and project tool calls into UI plan steps.
   */
  function readSessionPlanSteps(
    gatewayAgentId: string,
    sessionId: string,
  ): MessagePlanStep[] {
    const dir = getSessionsDir(gatewayAgentId);
    const trajectoryPath = join(dir, `${sessionId}.trajectory.jsonl`);
    const text = safeReadText(trajectoryPath);

    return text ? parseOpenClawTrajectorySteps(text) : [];
  }

  /**
   * Get full session detail: metadata + messages.
   */
  function getSessionDetail(gatewayAgentId: string, sessionId: string): {
    session: SessionInfo | null;
    messages: SessionMessage[];
  } {
    const sessions = readSessionsIndex(gatewayAgentId);
    const session = sessions.find((s) => s.sessionId === sessionId) ?? null;
    const messages = readSessionMessages(gatewayAgentId, sessionId);

    return { session, messages };
  }

  /**
   * Resolve a sessionKey (e.g. "agent:main:main") to the OpenClaw sessionId (UUID).
   * Returns undefined if not found in the sessions index.
   */
  function resolveSessionId(gatewayAgentId: string, sessionKey: string): string | undefined {
    const dir = getSessionsDir(gatewayAgentId);
    const indexPath = join(dir, 'sessions.json');

    if (!existsSync(indexPath)) return undefined;

    let raw: Record<string, DiskSessionEntry>;
    try {
      raw = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch {
      return undefined;
    }

    // Direct key lookup
    if (raw[sessionKey]?.sessionId) {
      return raw[sessionKey].sessionId;
    }

    // Fallback: scan all entries for matching key/sessionId
    return Object.values(raw).find(
      (entry) => entry.key === sessionKey || entry.sessionId === sessionKey,
    )?.sessionId;
  }

  /**
   * List sessions for a given user by looking up their agent's Gateway agent ID
   * and reading its sessions index from disk.
   */
  function listSessionsForUser(userId: string): SessionInfo[] {
    const agent = store.getAgentByUserId(userId);
    if (!agent?.gatewayAgentId) return [];

    return readSessionsIndex(agent.gatewayAgentId);
  }

  return {
    readSessionsIndex,
    readSessionMessages,
    readSessionPlanSteps,
    getSessionDetail,
    listSessionsForUser,
    resolveSessionId,
  };
}

export type SessionService = ReturnType<typeof createSessionService>;
