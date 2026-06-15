import type { Message, Task } from '@xuanzhi/shared/protocol';

import { getOpenClawClient } from '../agents/openclawClient.js';
import { runOpenClawSession } from '../agents/agentRunner.js';
import type { MemoryStore } from '../repositories/memoryStore.js';
import type { StreamHub } from '../realtime/streamHub.js';
import type { FileAssetService } from './fileAssetService.js';
import { toolCallToPlanStep } from './sessionService.js';
import type { SessionService } from './sessionService.js';

export function createMessageService(
  store: MemoryStore,
  stream: StreamHub,
  sessionService?: SessionService,
  fileService?: FileAssetService,
) {
  const agentRunQueues = new Map<string, Promise<void>>();

  function titleFromMessage(content: string) {
    return content.trim().replace(/\s+/g, ' ').slice(0, 28);
  }

  function isDefaultConversationTitle(title: string) {
    return /^新对话(?:\s\([a-zA-Z0-9-]{8}\))?$/.test(title.trim());
  }

  const handleRuntimeFailure = (task: Task, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const assistantMessage = store.addMessage({
      userId: task.userId,
      taskId: task.id,
      role: 'assistant',
      content: 'Agent 运行失败，请稍后重试。',
    });
    stream.broadcast(task.id, { type: 'message.created', data: assistantMessage });

    const updated = store.updateTaskStatus(task.id, 'failed');
    if (updated) {
      stream.broadcast(task.id, { type: 'task.updated', data: updated });
    }

    const event = store.addEvent({
      userId: task.userId,
      taskId: task.id,
      type: 'agent.error',
      title: 'Agent 运行失败',
      message,
      status: 'error',
    });
    stream.broadcast(task.id, { type: 'agent.event.created', data: event });
  };

  const runAgent = (task: Task, queueKey: string, handler: () => Promise<void> | void) => {
    const previous = agentRunQueues.get(queueKey) ?? Promise.resolve();
    const execution = previous
      .catch(() => undefined)
      .then(() => handler());
    const tracked = execution
      .catch((error) => handleRuntimeFailure(task, error))
      .finally(() => {
        if (agentRunQueues.get(queueKey) === tracked) {
          agentRunQueues.delete(queueKey);
        }
      });
    agentRunQueues.set(queueKey, tracked);
  };

  function findLastAssistantIndex(messages: Array<{ role: Message['role'] }>) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'assistant') return index;
    }
    return -1;
  }

  function mergeMessages(diskMessages: Message[], localMessages: Message[]) {
    const merged: Message[] = [];
    const seenIds = new Set<string>();
    const seenMirrors = new Set<string>();

    const mirrorWindowMs = 30_000;
    const normalizeContent = (content: string) => content.trim().replace(/\s+/g, ' ');
    const mirrorKey = (message: Message) => `${message.role}:${normalizeContent(message.content)}`;
    const idAliases = new Map<string, string>();
    const canonicalId = (id: string | undefined) => {
      if (!id) return undefined;
      let current = id;
      const visited = new Set<string>();
      while (idAliases.has(current) && !visited.has(current)) {
        visited.add(current);
        current = idAliases.get(current)!;
      }
      return current;
    };
    const canonicalParentId = (message: Message) => canonicalId(message.parentMessageId);
    const planStepCount = (message: Message) => message.planSteps?.length ?? 0;
    const toolCallCount = (message: Message) => message.toolCalls?.length ?? 0;
    const mergeMirroredMessage = (current: Message, next: Message): Message => {
      if (
        toolCallCount(next) > toolCallCount(current)
        || (toolCallCount(next) === toolCallCount(current) && planStepCount(next) > planStepCount(current))
      ) {
        return {
          ...next,
          id: current.id,
          createdAt: current.createdAt,
          parentMessageId: current.parentMessageId ?? next.parentMessageId,
        };
      }

      if (
        (toolCallCount(current) > 0 && toolCallCount(next) === 0)
        || (planStepCount(current) > 0 && planStepCount(next) === 0)
      ) {
        return current;
      }

      return current.status === 'streaming' && next.status === 'completed'
        ? { ...current, status: next.status }
        : current;
    };

    for (const message of [...diskMessages, ...localMessages]) {
      if (seenIds.has(message.id)) {
        continue;
      }

      const key = mirrorKey(message);
      const createdAtMs = Date.parse(message.createdAt);
      const parentMirroredIndex = message.role === 'assistant' && canonicalParentId(message)
        ? merged.findIndex((candidate) => (
          candidate.role === 'assistant'
          && canonicalParentId(candidate) === canonicalParentId(message)
        ))
        : -1;
      if (parentMirroredIndex >= 0) {
        const keptId = merged[parentMirroredIndex]!.id;
        merged[parentMirroredIndex] = mergeMirroredMessage(merged[parentMirroredIndex]!, message);
        idAliases.set(message.id, keptId);
        seenIds.add(message.id);
        continue;
      }

      const mirroredIndex = merged.findIndex((candidate) => {
        if (mirrorKey(candidate) !== key) return false;
        const candidateCreatedAtMs = Date.parse(candidate.createdAt);
        if (!Number.isFinite(createdAtMs) || !Number.isFinite(candidateCreatedAtMs)) {
          return true;
        }
        return Math.abs(createdAtMs - candidateCreatedAtMs) <= mirrorWindowMs;
      });

      if (mirroredIndex >= 0) {
        const keptId = merged[mirroredIndex]!.id;
        merged[mirroredIndex] = mergeMirroredMessage(merged[mirroredIndex]!, message);
        idAliases.set(message.id, keptId);
        seenIds.add(message.id);
        continue;
      }

      if (seenMirrors.has(`${key}:${message.createdAt}`)) {
        continue;
      }

      seenIds.add(message.id);
      seenMirrors.add(`${key}:${message.createdAt}`);
      merged.push(message);
    }

    return merged.sort((left, right) => (
      Date.parse(left.createdAt) - Date.parse(right.createdAt)
    ));
  }

  function readOpenClawDiskMessages(task: Task): Message[] {
    if (!sessionService || !task.sessionKey) return [];

    const agent = task.agentId ? store.getAgent(task.agentId) : store.getAgentByUserId(task.userId);
    if (!agent?.gatewayAgentId) return [];

    const sessionId = sessionService.resolveSessionId(
      agent.gatewayAgentId,
      task.sessionKey,
    );
    if (!sessionId) return [];

    const sessionMessages = sessionService.readSessionMessages(
      agent.gatewayAgentId,
      sessionId,
    );
    if (sessionMessages.length === 0) return [];

    const hasStructuredToolCalls = sessionMessages.some((sm) => sm.toolCalls?.length);
    const trajectoryPlanSteps = hasStructuredToolCalls
      ? []
      : sessionService.readSessionPlanSteps(agent.gatewayAgentId, sessionId);
    const lastAssistantIndex = findLastAssistantIndex(sessionMessages);

    return sessionMessages.map((sm, index) => {
      const structuredPlanSteps = sm.toolCalls?.length
        ? sm.toolCalls.map((toolCall) => toolCallToPlanStep(toolCall))
        : undefined;
      return {
        id: sm.id,
        userId: task.userId,
        taskId: task.id,
        role: sm.role,
        content: sm.content,
        parentMessageId: sm.parentMessageId,
        status: 'completed' as const,
        toolCalls: sm.toolCalls?.length ? sm.toolCalls : undefined,
        planSteps: structuredPlanSteps
          ?? (index === lastAssistantIndex && trajectoryPlanSteps.length > 0 ? trajectoryPlanSteps : undefined),
        createdAt: sm.createdAt,
      };
    });
  }

  return {
    createMessage(task: Task, input: { role?: Message['role']; content: string; contextFileIds?: string[] }) {
      const role = input.role === 'assistant' || input.role === 'system' ? input.role : 'user';
      const previousMessages = mergeMessages(readOpenClawDiskMessages(task), store.listMessages(task.id));
      const firstUserMessage = role === 'user' && previousMessages.every((message) => message.role !== 'user');
      const shouldRenameTask = firstUserMessage && isDefaultConversationTitle(task.title);
      const activeTask = shouldRenameTask
        ? store.updateTaskTitle(task.id, titleFromMessage(input.content)) ?? task
        : task;
      if (activeTask !== task) {
        stream.broadcast(activeTask.id, { type: 'task.updated', data: activeTask });
      }

      const message = store.addMessage({
        userId: activeTask.userId,
        taskId: activeTask.id,
        role,
        content: input.content,
        contextFileIds: input.contextFileIds,
      });
      stream.broadcast(activeTask.id, { type: 'message.created', data: message });

      // 所有消息走 OpenClaw Gateway Agent
      if (message.role === 'user') {
        const client = getOpenClawClient();
        const agent = activeTask.agentId ? store.getAgent(activeTask.agentId) : store.getAgentByUserId(activeTask.userId);
        const contextText = input.contextFileIds?.length && fileService
          ? fileService.buildContextText(activeTask.userId, input.contextFileIds)
          : '';
        const runtimeContent = contextText
          ? `${message.content}\n\n---\n以下文件已加入本轮上下文：\n${contextText}`
          : message.content;
        const queueKey = agent?.workspace || agent?.id || activeTask.userId;

        if (input.contextFileIds?.length && fileService) {
          fileService.recordUsedInChat(activeTask.userId, input.contextFileIds, activeTask.id);
        }

        if (client.isConnected()) {
          const isFollowup = !!agent?.gatewayAgentId;
          runAgent(activeTask, queueKey, () =>
            runOpenClawSession(
              activeTask,
              runtimeContent,
              store,
              stream,
              fileService,
              isFollowup,
              message.id,
              sessionService,
            ),
          );
        } else {
          // OpenClaw 未连接，先触发连接再执行
          runAgent(activeTask, queueKey, async () => {
            await client.connect();
            const freshAgent = activeTask.agentId ? store.getAgent(activeTask.agentId) : store.getAgentByUserId(activeTask.userId);
            const isFollowup = !!freshAgent?.gatewayAgentId;
            await runOpenClawSession(
              activeTask,
              runtimeContent,
              store,
              stream,
              fileService,
              isFollowup,
              message.id,
              sessionService,
            );
          });
        }
      }

      return message;
    },

    listMessages(taskId: string) {
      const local = store.listMessages(taskId);
      const task = store.tasks.get(taskId);
      if (!task) return local;

      const diskMessages = readOpenClawDiskMessages(task);
      return diskMessages.length > 0 ? mergeMessages(diskMessages, local) : local;
    },
  };
}

export type MessageService = ReturnType<typeof createMessageService>;
