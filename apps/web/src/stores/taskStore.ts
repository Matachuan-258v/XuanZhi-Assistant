import type { Message } from '../types/protocol';

type WithId = {
  id: string;
};

export function upsertById<T extends WithId>(items: T[], next: T) {
  const exists = items.some((item) => item.id === next.id);
  if (!exists) {
    return [...items, next];
  }
  return items.map((item) => (item.id === next.id ? next : item));
}

export function replaceTaskRecord<T>(records: Record<string, T>, taskId: string, value: T) {
  return {
    ...records,
    [taskId]: value,
  };
}

export function upsertTaskRecordItem<T extends WithId>(records: Record<string, T[]>, taskId: string, value: T) {
  return {
    ...records,
    [taskId]: upsertById(records[taskId] ?? [], value),
  };
}

function messageTime(message: Message) {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortMessagesForDisplay(messages: Message[]) {
  const baseOrder = messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const timeDelta = messageTime(left.message) - messageTime(right.message);
      return timeDelta || left.index - right.index;
    });
  const baseRank = new Map(baseOrder.map((item, index) => [item.message.id, index]));
  const byId = new Map(messages.map((message) => [message.id, message]));
  const childrenByParent = new Map<string, Message[]>();
  const incomingCount = new Map(messages.map((message) => [message.id, 0]));

  for (const message of messages) {
    if (!message.parentMessageId || !byId.has(message.parentMessageId)) {
      continue;
    }
    childrenByParent.set(message.parentMessageId, [
      ...(childrenByParent.get(message.parentMessageId) ?? []),
      message,
    ]);
    incomingCount.set(message.id, (incomingCount.get(message.id) ?? 0) + 1);
  }

  const sorted: Message[] = [];
  const ready = baseOrder
    .map((item) => item.message)
    .filter((message) => (incomingCount.get(message.id) ?? 0) === 0);

  while (ready.length > 0) {
    ready.sort((left, right) => (baseRank.get(left.id) ?? 0) - (baseRank.get(right.id) ?? 0));
    const message = ready.shift()!;
    sorted.push(message);

    for (const child of childrenByParent.get(message.id) ?? []) {
      const nextCount = (incomingCount.get(child.id) ?? 0) - 1;
      incomingCount.set(child.id, nextCount);
      if (nextCount === 0) {
        ready.push(child);
      }
    }
  }

  if (sorted.length !== messages.length) {
    const emitted = new Set(sorted.map((message) => message.id));
    for (const item of baseOrder) {
      if (!emitted.has(item.message.id)) {
        sorted.push(item.message);
      }
    }
  }

  return sorted;
}

export function replaceTaskMessagesRecord(
  records: Record<string, Message[]>,
  taskId: string,
  messages: Message[],
) {
  return {
    ...records,
    [taskId]: sortMessagesForDisplay(messages),
  };
}

export function upsertTaskMessageRecordItem(
  records: Record<string, Message[]>,
  taskId: string,
  message: Message,
) {
  return {
    ...records,
    [taskId]: sortMessagesForDisplay(upsertById(records[taskId] ?? [], message)),
  };
}
