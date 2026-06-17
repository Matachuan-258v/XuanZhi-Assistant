import { Empty } from '../ui';

import type { FileAsset, Message } from '../../types/protocol';
import { ChatCanvas } from './ChatCanvas';

type ChatPanelProps = {
  messages: Message[];
  renderKey: string;
  files?: FileAsset[];
  onCopyMessage: (content: string) => void;
  onEditMessage: (content: string) => void;
};

export function ChatPanel({
  files = [],
  messages,
  renderKey,
  onCopyMessage,
  onEditMessage,
}: ChatPanelProps) {
  const hasMessages = messages.length > 0;

  return (
    <div className="chat-panel">
      {hasMessages ? (
        <ChatCanvas
          files={files}
          messages={messages}
          renderKey={renderKey}
          onCopyMessage={onCopyMessage}
          onEditMessage={onEditMessage}
        />
      ) : (
        <Empty className="chat-empty" description="这个任务还没有消息" />
      )}
    </div>
  );
}
