import { useState, type ReactNode } from 'react';
import { Conversations } from '@ant-design/x';

import { Avatar, Button, Input, Modal, Text, Tooltip } from '../ui';
import { Icon } from '../ui/icons';
import type { FileAssetCategory, Task, User } from '../../types/protocol';
import { AgentProfilePanel } from './AgentProfilePanel';

type SidebarProps = {
  activeKey?: string;
  activeAgentId: string;
  activeWorkspace: WorkspaceKey;
  agentItems: SidebarAgentItem[];
  collapsed: boolean;
  currentUser: User;
  activeFileCategory: FileAssetCategory | 'all';
  fileCounts: Record<FileAssetCategory | 'all', number>;
  tasks: Task[];
  canCreateConversation: boolean;
  onActiveChange: (taskId: string) => void;
  onAgentSelect: (agentId: string) => void;
  onCreateConversation: () => void;
  onCreateAgent: () => void;
  onFileCategoryChange: (category: FileAssetCategory | 'all') => void;
  onToggleSidebar: () => void;
  onWorkspaceChange: (workspace: WorkspaceKey) => void;
  onLogout: () => void;
};

export type WorkspaceKey = 'chat' | 'file' | 'team';

export type SidebarAgentItem = {
  id: string;
  name: string;
  description: string;
  avatar: string;
  tone: string;
  isRunning: boolean;
};

const activeTaskStatuses = new Set<Task['status']>(['created', 'planning', 'running', 'waiting_approval']);

function isTaskActive(status: Task['status']) {
  return activeTaskStatuses.has(status);
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

const baseNavRailItems: Array<{ key: WorkspaceKey; label: string; icon: ReactNode }> = [
  { key: 'chat', label: '对话', icon: <Icon name="message" /> },
  { key: 'file', label: '文件', icon: <Icon name="file-text" /> },
];

const adminNavRailItems: Array<{ key: WorkspaceKey; label: string; icon: ReactNode }> = [
  { key: 'team', label: '团队', icon: <Icon name="database" /> },
];

const fileCategories: Array<{ key: FileAssetCategory | 'all'; label: string; icon: ReactNode }> = [
  { key: 'all', label: '全部类型', icon: <Icon name="folder" /> },
  { key: 'documents', label: '文档', icon: <Icon name="file-text" /> },
  { key: 'spreadsheets', label: '表格', icon: <Icon name="table" /> },
  { key: 'images', label: '图片', icon: <Icon name="image" /> },
  { key: 'code', label: '代码', icon: <Icon name="file-search" /> },
  { key: 'presentations', label: 'PPT', icon: <Icon name="book" /> },
  { key: 'reports', label: 'PDF', icon: <Icon name="file-search" /> },
  { key: 'others', label: '其他', icon: <Icon name="more" /> },
];

const settingsMenuItems = [
  { key: 'general', label: '通用设置', icon: <Icon name="settings" /> },
  { key: 'agent-profile', label: '智能体配置', icon: <Icon name="tool" /> },
];

function SettingsCenter({ currentUser, onLogout }: { currentUser: User; onLogout: () => void }) {
  const [activeSetting, setActiveSetting] = useState('general');
  const isAdmin = currentUser.role === 'admin';
  const activeLabel = settingsMenuItems.find((m) => m.key === activeSetting)?.label ?? '通用设置';

  return (
    <div className="settings-shell">
      <aside className="settings-sidebar">
        <Text className="settings-title" strong>
          设置
        </Text>
        <div className="settings-menu">
          {settingsMenuItems.map((item) => (
            <button
              key={item.key}
              className={activeSetting === item.key ? 'settings-menu-item is-active' : 'settings-menu-item'}
              type="button"
              onClick={() => setActiveSetting(item.key)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="settings-content">
        <div className="settings-content-header">
          <Text strong>{activeLabel}</Text>
        </div>

        {activeSetting === 'agent-profile' ? (
          <AgentProfilePanel currentUserId={currentUser.id} isAdmin={isAdmin} />
        ) : (
          <>
            <div className="settings-card">
              <div className="settings-row">
                <Text strong>头像</Text>
                <Avatar size={42} icon={<Icon name="user" />} />
              </div>
              <div className="settings-row">
                <Text strong>用户名</Text>
                <span className="settings-user-badge">
                  <Icon name="check-circle" />
                  {currentUser.name}
                </span>
              </div>
              <div className="settings-row">
                <Text strong>外观</Text>
                <button className="settings-select" type="button">
                  浅色模式
                  <Icon name="chevron-right-panel" />
                </button>
              </div>
              <div className="settings-row is-stacked">
                <div className="settings-row-title">
                  <Text strong>字体大小</Text>
                  <Text type="secondary">中</Text>
                </div>
                <div className="settings-slider" aria-hidden="true">
                  <span />
                </div>
                <div className="settings-scale">
                  <span>小</span>
                  <span>中</span>
                  <span>大</span>
                </div>
              </div>
            </div>

            <div className="settings-switch-list">
              {[
                ['安全管家', '开启后可实时保护 AI 安全，防范漏洞攻击、拦截恶意指令。'],
                ['休眠阻止', '开启后电脑不会进入休眠模式，玄知助手会保持活跃状态。'],
                ['云端同步', 'AI 生成的文件将自动同步至云端，方便跨设备访问和备份。'],
                ['高级功能设置', '高级功能使用过程中会带来额外 Token 消耗。'],
              ].map(([title, description]) => (
                <div className="settings-switch-row" key={title}>
                  <span>
                    <Text strong>{title}</Text>
                    <Text type="secondary">{description}</Text>
                  </span>
                  <button className="settings-switch is-on" type="button" aria-pressed="true">
                    <span />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <Button type="text" className="settings-logout-button" onClick={onLogout}>
          退出当前账号
        </Button>
      </section>
    </div>
  );
}

function FileSidebarPanel({
  activeCategory,
  counts,
  onCategoryChange,
}: {
  activeCategory: FileAssetCategory | 'all';
  counts: Record<FileAssetCategory | 'all', number>;
  onCategoryChange: (category: FileAssetCategory | 'all') => void;
}) {
  return (
    <div className="file-sidebar-panel">
      <Text className="file-sidebar-title" strong>
        文件空间
      </Text>
      <div className="file-sidebar-storage">
        <span>云端文件</span>
        <span>
          <Icon name="cloud" />
          {counts.all} 个文件
        </span>
      </div>
      <div className="file-category-list" aria-label="文件分类">
        {fileCategories.map((item) => (
          <button
            className={item.key === activeCategory ? 'file-category-item is-active' : 'file-category-item'}
            key={item.key}
            type="button"
            onClick={() => onCategoryChange(item.key)}
          >
            <span className="file-category-main">
              {item.icon}
              <span>{item.label}</span>
            </span>
            <span className="file-category-count">{counts[item.key] ?? 0}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Sidebar({
  activeKey,
  activeAgentId,
  activeWorkspace,
  agentItems,
  collapsed,
  currentUser,
  activeFileCategory,
  fileCounts,
  tasks,
  canCreateConversation,
  onActiveChange,
  onAgentSelect,
  onCreateConversation,
  onCreateAgent,
  onFileCategoryChange,
  onToggleSidebar,
  onWorkspaceChange,
  onLogout,
}: SidebarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hasActiveTask = agentItems.some((agent) => agent.isRunning);
  const navRailItems = currentUser.role === 'admin'
    ? [...baseNavRailItems, ...adminNavRailItems]
    : baseNavRailItems;

  const sortedTasks = [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const conversationItems = sortedTasks.map((task) => {
    const taskActive = isTaskActive(task.status);
    const isSessionTask = task.id.startsWith('session_');
    const timeLabel = formatConversationTime(task.updatedAt);

    return {
      key: task.id,
      label: (
        <span className="conversation-title">
          <span className="conversation-title-text">{task.title}</span>
          {isSessionTask ? <span className="conversation-badge" title="OpenClaw 历史会话">历史</span> : null}
          {timeLabel ? <span className="conversation-title-time">{timeLabel}</span> : null}
        </span>
      ),
      icon: taskActive ? (
        <span className="conversation-item-spinner" aria-label="任务进行中">
          <Icon name="loader" />
        </span>
      ) : isSessionTask ? (
        <Icon name="clock" />
      ) : (
        <Icon name="message" />
      ),
    };
  });

  return (
    <aside className={`assistant-sidebar ${collapsed ? 'is-rail-only' : ''}`}>
      <nav className="assistant-nav-rail" aria-label="主导航">
        <button
          className="nav-avatar-trigger"
          type="button"
          aria-label="打开设置"
          onClick={() => setSettingsOpen(true)}
        >
          <Avatar size={38} icon={<Icon name="user" />} />
        </button>
        <div className="nav-rail-list">
          {navRailItems.map((item) => (
            <button
              key={item.key}
              className={item.key === activeWorkspace ? 'nav-rail-item is-active' : 'nav-rail-item'}
              type="button"
              aria-current={item.key === activeWorkspace ? 'page' : undefined}
              onClick={() => onWorkspaceChange(item.key)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        <div className="nav-rail-bottom">
          <Tooltip title="展开侧栏">
            <button
              className="nav-rail-icon collapsed-toolbar-button collapsed-expand-button"
              type="button"
              aria-label="展开侧栏"
              tabIndex={collapsed ? 0 : -1}
              onClick={onToggleSidebar}
            >
              <Icon name="chevron-right-panel" />
            </button>
          </Tooltip>
          <Tooltip title="搜索会话">
            <button
              className="nav-rail-icon collapsed-toolbar-button"
              type="button"
              aria-label="搜索会话"
              tabIndex={collapsed ? 0 : -1}
              onClick={onToggleSidebar}
            >
              <Icon name="search" />
            </button>
          </Tooltip>
          <Tooltip title="开启新对话">
            <button
              className="nav-rail-icon collapsed-toolbar-button collapsed-new-chat-button"
              type="button"
              aria-label="开启新对话"
              disabled={!canCreateConversation}
              tabIndex={collapsed ? 0 : -1}
              onClick={onCreateConversation}
            >
              <Icon name="plus" />
            </button>
          </Tooltip>
          <button className="nav-rail-icon settings-rail-button" type="button" aria-label="设置" onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" />
          </button>
        </div>
      </nav>

      <div className="assistant-sidebar-panel" aria-hidden={collapsed}>
        {activeWorkspace === 'file' ? (
          <FileSidebarPanel
            activeCategory={activeFileCategory}
            counts={fileCounts}
            onCategoryChange={onFileCategoryChange}
          />
        ) : activeWorkspace === 'team' ? (
          <div className="file-sidebar-panel">
            <Text className="file-sidebar-title" strong>
              团队管理
            </Text>
            <Text type="secondary">查看用户、Agent 和 workspace 绑定关系。</Text>
          </div>
        ) : (
          <>
            <Input className="sidebar-search" prefix={<Icon name="search" />} placeholder="搜索" aria-label="搜索会话" />

            <div className="sidebar-action-stack">
              <Button
                icon={(
                  <span className="new-chat-plus-mark">
                    <Icon name="plus" />
                  </span>
                )}
                className="new-chat-button"
                disabled={!canCreateConversation}
                onClick={onCreateConversation}
              >
                <span className="new-chat-label">开启新对话</span>
              </Button>
              {currentUser.role === 'admin' ? (
                <Button icon={<Icon name="user" />} className="new-agent-button" onClick={onCreateAgent}>
                  新建 Agent
                </Button>
              ) : null}
            </div>

            <div className="agent-list" aria-label="Agent 列表" data-has-active-task={hasActiveTask ? 'true' : 'false'}>
              {agentItems.map((agent) => {
                const selected = agent.id === activeAgentId;

                return (
                  <button
                    key={agent.id}
                    className={[
                      'assistant-agent-card',
                      selected ? 'is-active' : '',
                      agent.isRunning ? 'is-running' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    type="button"
                    onClick={() => onAgentSelect(agent.id)}
                  >
                    <span className="agent-card-avatar-wrap">
                      <span className={`agent-card-avatar is-${agent.tone}`}>
                        {agent.avatar === 'thunderbolt' ? <Icon name="thunderbolt" /> : agent.avatar}
                      </span>
                      {agent.isRunning ? (
                        <span className="agent-card-spinner" aria-label="任务进行中">
                          <Icon name="loader" />
                        </span>
                      ) : null}
                    </span>
                    <span className="agent-card-copy">
                      <Text strong>{agent.name}</Text>
                      <Text type="secondary">{agent.description || '主对话'}</Text>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="sidebar-section-row is-sessions">
              <span>对话</span>
              <small>{sortedTasks.length} 条</small>
            </div>

            <Conversations
              className="conversation-list"
              activeKey={activeKey}
              items={conversationItems}
              onActiveChange={onActiveChange}
            />
          </>
        )}
      </div>

      <Modal
        title="设置"
        open={settingsOpen}
        footer={null}
        width={840}
        className="settings-modal"
        centered
        onCancel={() => setSettingsOpen(false)}
      >
        <SettingsCenter currentUser={currentUser} onLogout={onLogout} />
      </Modal>
    </aside>
  );
}
