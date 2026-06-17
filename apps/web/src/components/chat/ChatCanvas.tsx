import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Bubble } from '@ant-design/x';

import * as fileApi from '../../services/fileApi';
import type { FileAsset, Message } from '../../types/protocol';
import { normalizeAgentMessage } from '../../utils/agentMessage';
import { AssistantMessageContent } from './AssistantMessageContent';
import { MessageActions } from './MessageActions';

const bubbleRoles = {
  assistant: {
    placement: 'start' as const,
    variant: 'borderless' as const,
    shape: 'round' as const,
    className: 'assistant-message',
    styles: {
      content: {
        background: 'transparent',
        border: 0,
        boxShadow: 'none',
        padding: 0,
      },
    },
  },
  user: {
    placement: 'end' as const,
    variant: 'filled' as const,
    shape: 'round' as const,
    className: 'user-message',
    styles: {
      content: {
        background: '#eaf2ff',
        color: '#172033',
      },
    },
  },
};

type ChatCanvasProps = {
  files?: FileAsset[];
  messages: Message[];
  renderKey: string;
  onCopyMessage: (content: string) => void;
  onEditMessage: (content: string) => void;
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function messageTime(message: Message) {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileTime(file: FileAsset) {
  const parsed = Date.parse(file.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function TaskFileStrip({ files }: { files: FileAsset[] }) {
  if (files.length === 0) return null;

  return (
    <div className="task-file-strip" aria-label="本条回复生成的文件">
      <div className="task-file-strip-header">
        <span>生成文件</span>
      </div>
      <div className="task-file-strip-list">
        {files.map((file) => (
          <a className="task-file-card" href={fileApi.getFileDownloadUrl(file.id)} key={file.id}>
            <span className={`task-file-type is-${file.category}`}>{file.extension.toUpperCase()}</span>
            <span className="task-file-copy">
              <strong>{file.name}</strong>
              <small>{formatSize(file.sizeBytes)} | {file.category}</small>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

function groupFilesByAssistantMessage(messages: Message[], files: FileAsset[]) {
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const grouped = new Map<string, FileAsset[]>();

  for (const file of files) {
    let owner = file.messageId ? assistantMessages.find((message) => message.id === file.messageId) : undefined;
    if (!owner) {
      const createdAt = fileTime(file);
      owner = [...assistantMessages]
        .reverse()
        .find((message) => messageTime(message) <= createdAt)
        ?? assistantMessages.at(-1);
    }
    if (!owner) continue;
    grouped.set(owner.id, [...(grouped.get(owner.id) ?? []), file]);
  }

  for (const [messageId, ownedFiles] of grouped) {
    grouped.set(messageId, [...ownedFiles].sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  return grouped;
}

export function ChatCanvas({ files = [], messages, renderKey, onCopyMessage, onEditMessage }: ChatCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const isPinnedToBottomRef = useRef(true);
  const filesByAssistantMessage = useMemo(
    () => groupFilesByAssistantMessage(messages, files),
    [files, messages],
  );
  const messageItems = useMemo(
    () =>
      messages.map((message) => {
        const normalized = message.role === 'assistant' ? normalizeAgentMessage(message) : undefined;

        return {
          key: message.id,
          role: message.role === 'user' ? 'user' : 'assistant',
          content:
            message.role === 'assistant' ? (
              <>
                <AssistantMessageContent message={message}
                  key={`${message.id}:${renderKey}`}
                  normalized={normalized}
                />
              </>
            ) : (
              message.content
            ),
          message,
          footer: (
            <MessageActions
              message={normalized ? { ...message, content: normalized.copyContent } : message}
              onCopy={onCopyMessage}
              onEdit={onEditMessage}
            />
          ),
          footerPlacement: message.role === 'user' ? ('outer-end' as const) : ('outer-start' as const),
        };
      }),
    [messages, onCopyMessage, onEditMessage, renderKey],
  );
  const bubbleItems = useMemo(
    () =>
      messageItems.map(({ message, content, ...item }) => {
        const messageFiles = message.role === 'assistant'
          ? filesByAssistantMessage.get(message.id) ?? []
          : [];
        return {
          ...item,
          content: message.role === 'assistant' ? (
            <>
              {content}
              <TaskFileStrip files={messageFiles} />
            </>
          ) : content,
        };
      }),
    [filesByAssistantMessage, messageItems],
  );
  const messageScrollKey = useMemo(
    () => messages
      .map((message) => [
        message.id,
        message.status ?? '',
        message.content.length,
        message.planSteps?.length ?? 0,
        message.toolCalls?.map((toolCall) => `${toolCall.id}:${toolCall.status}:${toolCall.result?.length ?? 0}`).join(',') ?? '',
      ].join(':'))
      .concat(files.map((file) => `${file.id}:${file.messageId ?? ''}:${file.updatedAt}`).join('|'))
      .join('|'),
    [files, messages],
  );

  const findScrollParent = useCallback((node: HTMLElement | null): HTMLElement | Window => {
    let current = node?.parentElement;
    while (current) {
      const style = window.getComputedStyle(current);
      if (/(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`)) {
        return current;
      }
      current = current.parentElement;
    }
    return window;
  }, []);

  const updatePinnedToBottom = useCallback(() => {
    const scrollParent = findScrollParent(canvasRef.current);
    const threshold = 80;
    if (!(scrollParent instanceof HTMLElement)) {
      const scrollTop = window.scrollY;
      const viewportHeight = window.innerHeight;
      const scrollHeight = document.documentElement.scrollHeight;
      isPinnedToBottomRef.current = scrollHeight - scrollTop - viewportHeight <= threshold;
      return;
    }

    isPinnedToBottomRef.current = (
      scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight <= threshold
    );
  }, [findScrollParent]);

  const scrollToBottom = useCallback(() => {
    bottomAnchorRef.current?.scrollIntoView({ block: 'end' });
    isPinnedToBottomRef.current = true;
  }, []);

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [messageScrollKey, renderKey, scrollToBottom]);

  useEffect(() => {
    const scrollParent = findScrollParent(canvasRef.current);
    updatePinnedToBottom();
    scrollParent.addEventListener('scroll', updatePinnedToBottom, { passive: true });
    return () => scrollParent.removeEventListener('scroll', updatePinnedToBottom);
  }, [findScrollParent, updatePinnedToBottom]);

  useEffect(() => {
    const node = canvasRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(() => {
      if (isPinnedToBottomRef.current) {
        window.requestAnimationFrame(scrollToBottom);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  return (
    <div className="chat-canvas" ref={canvasRef}>
      <Bubble.List items={bubbleItems} role={bubbleRoles} autoScroll className="bubble-list" />
      <div className="chat-scroll-anchor" ref={bottomAnchorRef} aria-hidden="true" />
    </div>
  );
}
