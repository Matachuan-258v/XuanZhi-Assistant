import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { promptDrafts } from '../../data/assistantData';
import * as agentApi from '../../services/agentApi';
import * as approvalApi from '../../services/approvalApi';
import * as fileApi from '../../services/fileApi';
import * as messageApi from '../../services/messageApi';
import { subscribeTaskStream } from '../../services/streamClient';
import * as taskApi from '../../services/taskApi';
import {
  replaceTaskRecord,
  upsertById,
  upsertTaskRecordItem,
} from '../../stores/taskStore';
import type { Agent, AgentEvent, Approval, FileAsset, FileAssetCategory, FileFolder, Message, StreamEvent, Task, User } from '../../types/protocol';
import { qclawFileCategory } from '../../utils/fileCategory';
import { ApprovalCard } from '../chat/ApprovalCard';
import { ChatComposer } from '../chat/ChatComposer';
import type { ComposerCommand } from '../chat/ChatComposer';
import { ChatHome } from '../chat/ChatHome';
import { ChatPanel } from '../chat/ChatPanel';
import { FilePreviewModal } from '../files/FilePreviewModal';
import { FileSpacePage } from '../files/FileSpacePage';
import { toast } from '../ui';
import { Icon } from '../ui/icons';
import { AgentCreatePage } from './AgentCreatePage';
import { Sidebar } from './Sidebar';
import type { SidebarAgentItem, WorkspaceKey } from './Sidebar';
import { TeamAdminPage } from './TeamAdminPage';
import { WorkspaceHeader } from './WorkspaceHeader';

type AssistantShellProps = {
  currentUser: User;
  token: string;
  onLogout: () => void;
};

function getStreamEventTaskId(event: StreamEvent) {
  if (event.type === 'file.asset.created') return event.data.taskId;
  return event.type === 'task.updated' ? event.data.id : event.data.taskId;
}

const DEFAULT_AGENT_ID = 'agent-default';
const setupFlagPrefix = 'xuanzhi.agentSetup.pending.';
const activeTaskStatuses = new Set<Task['status']>(['created', 'planning', 'running', 'waiting_approval']);

type WorkspaceView = 'home' | 'chat' | 'agent-picker' | 'file' | 'team';

function isTaskStatusActive(status: Task['status']) {
  return activeTaskStatuses.has(status);
}

function getTaskAgentId(task: Task, taskAgentMap: Record<string, string>, fallbackAgentId: string) {
  return task.agentId ?? taskAgentMap[task.id] ?? fallbackAgentId;
}

function isMainTask(task: Task) {
  const key = task.sessionKey?.trim();
  return Boolean(key && (key === 'main' || key.endsWith(':main')));
}

function agentToSidebarItem(agent: Agent, tasks: Task[], taskAgentMap: Record<string, string>): SidebarAgentItem {
  const agentDisplayName = agent.profile?.agentName || agent.name;
  const roleDesc = agent.profile?.identity?.role || '';
  return {
    id: agent.id,
    name: agentDisplayName,
    description: roleDesc,
    avatar: agent.emoji ?? '🤖',
    tone: 'default',
    isRunning: tasks.some(
      (task) => getTaskAgentId(task, taskAgentMap, '') === agent.id && isTaskStatusActive(task.status),
    ),
  };
}

export function AssistantShell({ currentUser, token, onLogout }: AssistantShellProps) {
  const setupFlagKey = `${setupFlagPrefix}${currentUser.id}`;
  const [activeTaskId, setActiveTaskId] = useState<string>();
  const [activeAgentId, setActiveAgentId] = useState(DEFAULT_AGENT_ID);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [pendingInitialSetup, setPendingInitialSetup] = useState(() => (
    window.localStorage.getItem(setupFlagKey) === '1'
  ));
  const [taskAgentMap, setTaskAgentMap] = useState<Record<string, string>>({});
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('home');
  const [inputValue, setInputValue] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [messagesByTask, setMessagesByTask] = useState<Record<string, Message[]>>({});
  const [taskSnapshotsLoaded, setTaskSnapshotsLoaded] = useState<Record<string, boolean>>({});
  const [approvalsByTask, setApprovalsByTask] = useState<Record<string, Approval[]>>({});
  const [_eventsByTask, setEventsByTask] = useState<Record<string, AgentEvent[]>>({});
  const [files, setFiles] = useState<FileAsset[]>([]);
  const [filesByTask, setFilesByTask] = useState<Record<string, FileAsset[]>>({});
  const [filesLoading, setFilesLoading] = useState(false);
  const [activeFileCategory, setActiveFileCategory] = useState<FileAssetCategory | 'all'>('all');
  const [previewFile, setPreviewFile] = useState<FileAsset>();
  const [folders, setFolders] = useState<FileFolder[]>([]);
  const [contextFiles, setContextFiles] = useState<FileAsset[]>([]);
  const [approvingId, setApprovingId] = useState<string>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // 同一时间只订阅当前任务的 SSE，切换任务或登出时立即关闭，避免旧任务事件写入新视图。
  const streamCleanupRef = useRef<(() => void) | undefined>(undefined);
  const streamGenerationRef = useRef(0);
  const conversationCreationInFlightRef = useRef(false);

  const closeStream = useCallback(() => {
    streamGenerationRef.current += 1;
    streamCleanupRef.current?.();
    streamCleanupRef.current = undefined;
  }, []);

  const applyStreamEvent = useCallback((event: StreamEvent) => {
    switch (event.type) {
      case 'task.updated':
        setTasks((current) => upsertById(current, event.data));
        break;
      case 'message.created':
      case 'message.updated':
        setMessagesByTask((current) => upsertTaskRecordItem(current, event.data.taskId, event.data));
        break;
      case 'agent.event.created':
      case 'agent.event.updated':
        setEventsByTask((current) => upsertTaskRecordItem(current, event.data.taskId, event.data));
        break;
      case 'artifact.created':
        if (event.data.fileAsset) {
          const fileAsset = event.data.fileAsset;
          setFiles((current) => upsertById(current, fileAsset));
          setFilesByTask((current) => upsertTaskRecordItem(current, event.data.taskId, fileAsset));
        }
        break;
      case 'file.asset.created':
        setFiles((current) => upsertById(current, event.data));
        if (event.data.taskId) {
          const taskId = event.data.taskId;
          setFilesByTask((current) => upsertTaskRecordItem(current, taskId, event.data));
        }
        break;
      case 'approval.requested':
      case 'approval.updated':
        setApprovalsByTask((current) => upsertTaskRecordItem(current, event.data.taskId, event.data));
        break;
    }
  }, []);

  const applyTaskList = useCallback((nextTasks: Task[], fallbackAgentId?: string) => {
    setTasks(nextTasks);
    setTaskAgentMap((current) => {
      const next = { ...current };
      nextTasks.forEach((task) => {
        const mappedAgentId = task.agentId ?? next[task.id] ?? fallbackAgentId;
        if (mappedAgentId && mappedAgentId !== DEFAULT_AGENT_ID) {
          next[task.id] = mappedAgentId;
        }
      });
      return next;
    });
  }, []);

  const refreshTasks = useCallback(async (fallbackAgentId?: string) => {
    const nextTasks = await taskApi.listTasks();
    applyTaskList(nextTasks, fallbackAgentId);
    return nextTasks;
  }, [applyTaskList]);

  const loadTaskSnapshot = useCallback(async (taskId: string) => {
    const [task, messages, approvals, taskFiles] = await Promise.all([
      taskApi.getTask(taskId),
      messageApi.getTaskMessages(taskId),
      taskApi.getTaskApprovals(taskId),
      fileApi.listTaskFiles(taskId),
    ]);

    setTasks((current) => upsertById(current, task));
    setMessagesByTask((current) => replaceTaskRecord(current, taskId, messages));
    setApprovalsByTask((current) => replaceTaskRecord(current, taskId, approvals));
    setFilesByTask((current) => replaceTaskRecord(current, taskId, taskFiles));
    setFiles((current) => {
      const byId = new Map(current.map((file) => [file.id, file]));
      taskFiles.forEach((file) => byId.set(file.id, file));
      return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
    setTaskSnapshotsLoaded((current) => ({ ...current, [taskId]: true }));

    return task;
  }, []);

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const [activeFiles, deletedFiles] = await Promise.all([
        fileApi.listFiles(),
        fileApi.listFiles({ deleted: true }),
      ]);
      const fileMap = new Map(activeFiles.map((file) => [file.id, file]));
      deletedFiles.forEach((file) => fileMap.set(file.id, file));
      const nextFiles = [...fileMap.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const nextFolders = await fileApi.listFolders();
      setFiles(nextFiles);
      setFolders(nextFolders);
      setFilesByTask((current) => {
        const next = { ...current };
        nextFiles.forEach((file) => {
          if (file.taskId) {
            next[file.taskId] = upsertById(next[file.taskId] ?? [], file);
          }
        });
        return next;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载文件空间失败');
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const openTask = useCallback(
    async (taskId: string) => {
      closeStream();
      const streamGeneration = streamGenerationRef.current;
      setTaskSnapshotsLoaded((current) => ({ ...current, [taskId]: false }));
      setActiveTaskId(taskId);
      setWorkspaceView('chat');
      try {
        // 先加载任务快照再建立当前任务 SSE；创建新任务时会先进入这里，再发送首条消息触发 OpenClaw Agent。
        await loadTaskSnapshot(taskId);
        if (streamGeneration !== streamGenerationRef.current) {
          return;
        }
        // 只保存当前任务连接的关闭函数，切换任务时 closeStream 会停止旧连接继续写入状态。
        const cleanup = subscribeTaskStream(
          taskId,
          token,
          (event) => {
            const eventTaskId = getStreamEventTaskId(event);
            if (streamGeneration !== streamGenerationRef.current || eventTaskId !== taskId) {
              return;
            }
            applyStreamEvent(event);
          },
          () => {
            if (streamGeneration === streamGenerationRef.current) {
              toast.warning('任务实时连接已断开，请重新选择任务');
            }
          },
        );
        if (streamGeneration !== streamGenerationRef.current) {
          cleanup();
          return;
        }
        streamCleanupRef.current = cleanup;
      } catch (error) {
        if (streamGeneration === streamGenerationRef.current) {
          toast.error(error instanceof Error ? error.message : '加载任务失败');
        }
      }
    },
    [applyStreamEvent, closeStream, loadTaskSnapshot, token],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadInitialData() {
      try {
        const [backendAgents, nextTasks] = await Promise.all([
          agentApi.listAgents().catch(() => []),
          taskApi.listTasks(),
        ]);
        if (cancelled) {
          return;
        }
        const fallbackAgentId = backendAgents[0]?.id;
        setAgents(backendAgents);
        if (fallbackAgentId) {
          setActiveAgentId((current) => (current === DEFAULT_AGENT_ID ? fallbackAgentId : current));
        }
        applyTaskList(nextTasks, fallbackAgentId);
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : '加载任务列表失败');
        }
      }
    }

    void loadInitialData();
    void loadFiles();

    return () => {
      cancelled = true;
      closeStream();
    };
  }, [applyTaskList, closeStream, loadFiles]);

  const activeAgentTasks = useMemo(
    () => tasks.filter((task) => getTaskAgentId(task, taskAgentMap, activeAgentId) === activeAgentId),
    [activeAgentId, taskAgentMap, tasks],
  );

  const agentItems = useMemo<SidebarAgentItem[]>(
    () => agents.map((agent) => agentToSidebarItem(agent, tasks, taskAgentMap)),
    [agents, taskAgentMap, tasks],
  );

  const fileCounts = useMemo(() => {
    const activeFiles = files.filter((file) => !file.deletedAt);
    const next: Record<FileAssetCategory | 'all', number> = {
      all: activeFiles.length,
      code: 0,
      data: 0,
      documents: 0,
      images: 0,
      others: 0,
      presentations: 0,
      reports: 0,
      spreadsheets: 0,
    };
    activeFiles.forEach((file) => {
      next[qclawFileCategory(file)] += 1;
    });
    return next;
  }, [files]);

  const submitMessage = useCallback(
    async (value: string) => {
      const question = value.trim();

      if (!question) {
        return;
      }

      setInputValue('');

      try {
        const task =
          activeTaskId && activeAgentTasks.some((item) => item.id === activeTaskId)
            ? activeAgentTasks.find((item) => item.id === activeTaskId)
            : await taskApi.createTask({
                agentId: activeAgentId,
                title: question.slice(0, 28),
                userInput: question,
                intent: 'general',
              });

        if (!task) {
          return;
        }

        setTasks((current) => upsertById(current, task));
        setTaskAgentMap((current) => ({
          ...current,
          [task.id]: task.agentId ?? current[task.id] ?? activeAgentId,
        }));

        if (task.id !== activeTaskId) {
          // 新任务需要先打开详情并建立 SSE，再发送首条消息；OpenClaw Agent 会通过后端持续推送事件。
          await openTask(task.id);
        }

        const createdMessage = await messageApi.sendTaskMessage(
          task.id,
          question,
          contextFiles.map((file) => file.id),
        );
        setMessagesByTask((current) => upsertTaskRecordItem(current, task.id, createdMessage));
        setContextFiles([]);
        // OpenClaw Gateway 的首轮事件可能早于浏览器完成 SSE 建连；这里主动刷新一次快照。
        await loadTaskSnapshot(task.id);
        await refreshTasks(task.agentId ?? activeAgentId);
        setWorkspaceView('chat');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '发送失败');
        setInputValue(question);
      }
    },
    [activeAgentId, activeAgentTasks, activeTaskId, contextFiles, loadTaskSnapshot, openTask, refreshTasks],
  );

  const submitCommand = useCallback(
    (command: ComposerCommand) => {
      if (command === '/reset soft') {
        const confirmed = window.confirm('确定要向当前 OpenClaw 会话发送 /reset soft 吗？这会保留转录记录，并重建后端运行上下文。');
        if (!confirmed) {
          return;
        }
      }
      void submitMessage(command);
    },
    [submitMessage],
  );

  const createConversation = useCallback(async () => {
    const activeEmptyConversation = activeAgentTasks.find((task) => (
      task.id === activeTaskId
      && !isMainTask(task)
      && taskSnapshotsLoaded[task.id] === true
      && (messagesByTask[task.id]?.length ?? 0) === 0
    ));
    if (activeEmptyConversation) {
      setWorkspaceView('chat');
      return;
    }
    if (conversationCreationInFlightRef.current) {
      return;
    }

    closeStream();
    setInputValue('');
    if (!activeAgentId || activeAgentId === DEFAULT_AGENT_ID) {
      setActiveTaskId(undefined);
      setWorkspaceView('home');
      return;
    }

    conversationCreationInFlightRef.current = true;
    try {
      const task = await agentApi.createConversation(activeAgentId);
      setTasks((current) => upsertById(current, task));
      setTaskAgentMap((current) => ({
        ...current,
        [task.id]: task.agentId ?? current[task.id] ?? activeAgentId,
      }));
      await openTask(task.id);
      await refreshTasks(activeAgentId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建新对话失败');
      setActiveTaskId(undefined);
      setWorkspaceView('home');
    } finally {
      conversationCreationInFlightRef.current = false;
    }
  }, [
    activeAgentId,
    activeAgentTasks,
    activeTaskId,
    closeStream,
    messagesByTask,
    openTask,
    refreshTasks,
    taskSnapshotsLoaded,
  ]);

  const openAgentMainTask = useCallback(
    async (agentId: string) => {
      closeStream();
      setActiveAgentId(agentId);
      setInputValue('');
      try {
        const existingMainTask = tasks.find((task) => getTaskAgentId(task, taskAgentMap, agentId) === agentId && isMainTask(task));
        if (existingMainTask) {
          await openTask(existingMainTask.id);
          return;
        }
        const task = await agentApi.openMainTask(agentId);
        setTasks((current) => upsertById(current, task));
        setTaskAgentMap((current) => ({
          ...current,
          [task.id]: task.agentId ?? current[task.id] ?? agentId,
        }));
        await openTask(task.id);
        await refreshTasks(agentId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '打开 Agent 主对话失败');
        setWorkspaceView('home');
      }
    },
    [closeStream, openTask, refreshTasks, taskAgentMap, tasks],
  );

  const showFileSpace = useCallback(() => {
    closeStream();
    setActiveTaskId(undefined);
    setInputValue('');
    setWorkspaceView('file');
    void loadFiles();
  }, [closeStream, loadFiles]);

  const handleWorkspaceChange = useCallback(
    (workspace: WorkspaceKey) => {
      if (workspace === 'file') {
        showFileSpace();
        return;
      }

      if (workspace === 'team' && currentUser.role === 'admin') {
        closeStream();
        setActiveTaskId(undefined);
        setInputValue('');
        setWorkspaceView('team');
        return;
      }

      if (workspaceView === 'file' || workspaceView === 'team') {
        setWorkspaceView('home');
      }
    },
    [closeStream, currentUser.role, showFileSpace, workspaceView],
  );

  const showAgentCreatePage = useCallback(() => {
    closeStream();
    setActiveTaskId(undefined);
    setInputValue('');
    setWorkspaceView('agent-picker');
  }, [closeStream]);

  const handleFileCategoryChange = useCallback((category: FileAssetCategory | 'all') => {
    setActiveFileCategory(category);
    setWorkspaceView('file');
    setActiveTaskId(undefined);
  }, []);

  const handleFileCreated = useCallback((file: FileAsset) => {
    setFiles((current) => upsertById(current, file));
    if (file.taskId) {
      const taskId = file.taskId;
      setFilesByTask((current) => upsertTaskRecordItem(current, taskId, file));
    }
  }, []);

  const handleFileChanged = useCallback((file: FileAsset) => {
    setFiles((current) => upsertById(current, file));
    if (file.taskId) {
      const taskId = file.taskId;
      setFilesByTask((current) => upsertTaskRecordItem(current, taskId, file));
    }
    setPreviewFile((current) => (current?.id === file.id ? file : current));
  }, []);

  const handleFolderCreated = useCallback((folder: FileFolder) => {
    setFolders((current) => upsertById(current, folder));
  }, []);

  const handleFolderChanged = useCallback((folder: FileFolder) => {
    setFolders((current) => upsertById(current, folder));
  }, []);

  const handleFolderDeleted = useCallback((folderId: string) => {
    setFolders((current) => current.filter((folder) => folder.id !== folderId));
    setFiles((current) => current.map((file) => (
      file.folderId === folderId ? { ...file, folderId: undefined } : file
    )));
  }, []);

  const useFileAsContext = useCallback((file: FileAsset) => {
    setWorkspaceView('home');
    setContextFiles((current) => upsertById(current, file));
    setInputValue(
      `请基于文件「${file.name}」继续处理。\n文件路径：${file.workspacePath}\n需求：`,
    );
  }, []);

  const handleAgentCreated = useCallback(async (agentId: string) => {
    // Refresh agent list from backend
    try {
      const backendAgents = await agentApi.listAgents();
      window.localStorage.removeItem(setupFlagKey);
      setPendingInitialSetup(false);
      setAgents(backendAgents);
      setActiveAgentId(agentId);
      setActiveTaskId(undefined);
      setInputValue('');
      setWorkspaceView('home');
    } catch {
      setWorkspaceView('home');
    }
  }, [setupFlagKey]);

  const selectPrompt = useCallback((key: string) => {
    setInputValue(promptDrafts[key] ?? '');
  }, []);

  const copyMessage = useCallback((content: string) => {
    void navigator.clipboard?.writeText(content);
  }, []);

  const editMessage = useCallback((content: string) => {
    setInputValue(content);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => !collapsed);
  }, []);

  const approve = useCallback(async (approvalId: string) => {
    setApprovingId(approvalId);
    try {
      const approval = await approvalApi.approveApproval(approvalId);
      setApprovalsByTask((current) => upsertTaskRecordItem(current, approval.taskId, approval));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '确认失败');
    } finally {
      setApprovingId(undefined);
    }
  }, []);

  const reject = useCallback(async (approvalId: string) => {
    setApprovingId(approvalId);
    try {
      const approval = await approvalApi.rejectApproval(approvalId);
      setApprovalsByTask((current) => upsertTaskRecordItem(current, approval.taskId, approval));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '拒绝失败');
    } finally {
      setApprovingId(undefined);
    }
  }, []);

  const handleLogout = useCallback(() => {
    // 登出是用户隔离边界：关闭 SSE 并清掉所有任务态缓存，防止下一个用户看到上一位的残留数据。
    closeStream();
    setTasks([]);
    setMessagesByTask({});
    setTaskSnapshotsLoaded({});
    setApprovalsByTask({});
    setEventsByTask({});
    setFiles([]);
    setFilesByTask({});
    setPreviewFile(undefined);
    setActiveFileCategory('all');
    setFolders([]);
    setContextFiles([]);
    setTaskAgentMap({});
    setAgents([]);
    setActiveAgentId(DEFAULT_AGENT_ID);
    setActiveTaskId(undefined);
    setWorkspaceView('home');
    onLogout();
  }, [closeStream, onLogout]);

  const activeTask = activeAgentTasks.find((task) => task.id === activeTaskId);
  const activeAgent = agents.find((agent) => agent.id === activeAgentId) ?? agents[0];
  const activeAgentName = activeAgent?.profile?.agentName || activeAgent?.name || '玄知助手';
  const needsAgentSetup = Boolean(pendingInitialSetup && activeAgent && !activeAgent.profile);
  const activeMessages = activeTaskId ? messagesByTask[activeTaskId] ?? [] : [];
  const activeTaskSnapshotLoaded = activeTaskId ? taskSnapshotsLoaded[activeTaskId] === true : false;
  const activeFiles = activeTaskId ? filesByTask[activeTaskId] ?? [] : [];
  const activeApprovals = activeTaskId ? approvalsByTask[activeTaskId] ?? [] : [];
  const activePendingApprovals = activeApprovals.filter((approval) => approval.status === 'pending');
  const isChatting = Boolean(activeTask);
  const showConversationHome = Boolean(
    activeTask
    && activeTaskSnapshotLoaded
    && activeMessages.length === 0
  );
  const isAgentPicker = workspaceView === 'agent-picker' || needsAgentSetup;
  const isFileSpace = workspaceView === 'file';
  const isTeamSpace = workspaceView === 'team';
  const activeWorkspace: WorkspaceKey = isTeamSpace ? 'team' : isFileSpace ? 'file' : 'chat';

  return (
    <main className={`assistant-shell ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}>
      <Sidebar
        activeKey={activeTaskId}
        activeAgentId={activeAgentId}
        activeWorkspace={activeWorkspace}
        agentItems={agentItems}
        collapsed={sidebarCollapsed}
        currentUser={currentUser}
        activeFileCategory={activeFileCategory}
        fileCounts={fileCounts}
        tasks={activeAgentTasks.filter((task) => !isMainTask(task))}
        canCreateConversation={Boolean(activeAgentId && activeAgentId !== DEFAULT_AGENT_ID)}
        onActiveChange={(taskId) => void openTask(taskId)}
        onAgentSelect={(agentId) => void openAgentMainTask(agentId)}
        onCreateConversation={createConversation}
        onCreateAgent={showAgentCreatePage}
        onFileCategoryChange={handleFileCategoryChange}
        onToggleSidebar={toggleSidebar}
        onWorkspaceChange={handleWorkspaceChange}
        onLogout={handleLogout}
      />

      <section className={`assistant-main ${isFileSpace ? 'is-file-space' : isTeamSpace ? 'is-team-space' : isChatting ? 'is-chatting' : 'is-home'}`}>
        {isFileSpace || isTeamSpace ? null : (
          <WorkspaceHeader
            sidebarCollapsed={sidebarCollapsed}
            task={activeTask}
            onToggleSidebar={toggleSidebar}
          />
        )}

        <div className={`workspace-body ${isFileSpace ? 'is-file' : isTeamSpace ? 'is-team' : isChatting ? 'is-task' : ''}`}>
          {isFileSpace ? (
            <FileSpacePage
              activeAgentId={activeAgentId}
              activeCategory={activeFileCategory}
              files={files}
              folders={folders}
              loading={filesLoading}
              onCategoryChange={handleFileCategoryChange}
              onFileCreated={handleFileCreated}
              onFileChanged={handleFileChanged}
              onFolderCreated={handleFolderCreated}
              onFolderChanged={handleFolderChanged}
              onFolderDeleted={handleFolderDeleted}
              onOpenTask={(taskId) => void openTask(taskId)}
              onRefresh={() => void loadFiles()}
              onUseFileAsContext={useFileAsContext}
            />
          ) : isTeamSpace ? (
            <TeamAdminPage currentUser={currentUser} />
          ) : isAgentPicker ? (
            <AgentCreatePage
                currentUserId={currentUser.id}
                isAdmin={currentUser.role === 'admin'}
                existingAgent={activeAgent}
                onCreated={handleAgentCreated}
                onCancel={() => {
                  if (!needsAgentSetup) {
                    setWorkspaceView('home');
                  }
                }}
              />
          ) : isChatting && activeTask && !showConversationHome ? (
            <section className="task-chat-column">
              <ChatPanel
                files={activeFiles}
                messages={activeMessages}
                renderKey={token}
                onCopyMessage={copyMessage}
                onEditMessage={editMessage}
              />
            </section>
          ) : (
            <ChatHome
              agentName={activeAgentName}
              inputValue={inputValue}
              onInputChange={setInputValue}
              onCommand={submitCommand}
              onPromptSelect={selectPrompt}
              onSubmitMessage={submitMessage}
            />
          )}
        </div>

        {isChatting && !showConversationHome && !isFileSpace && !isTeamSpace ? (
          <footer className="composer-area">
            <div className="composer-stack">
              {contextFiles.length > 0 ? (
                <div className="composer-context-files" aria-label="已加入当前对话的文件">
                  {contextFiles.map((file) => (
                    <span className="composer-context-file" key={file.id}>
                      <Icon name="paperclip" />
                      {file.name}
                      <button
                        type="button"
                        aria-label={`移除 ${file.name}`}
                        onClick={() => setContextFiles((current) => current.filter((item) => item.id !== file.id))}
                      >
                        <Icon name="x" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              {activePendingApprovals.length > 0 ? (
                <div className="composer-approval-stack">
                  {activePendingApprovals.map((approval) => (
                    <ApprovalCard
                      key={approval.id}
                      approval={approval}
                      loading={approvingId === approval.id}
                      onApprove={approve}
                      onReject={reject}
                    />
                  ))}
                </div>
              ) : null}
              <ChatComposer
                agentName={activeAgentName}
                value={inputValue}
                variant="chat"
                onChange={setInputValue}
                onCommand={submitCommand}
                onSubmit={submitMessage}
              />
            </div>
          </footer>
        ) : null}
        <FilePreviewModal
          file={previewFile}
          folders={folders}
          onClose={() => setPreviewFile(undefined)}
          onFileChanged={handleFileChanged}
          onFileCreated={handleFileCreated}
          onOpenTask={(taskId) => {
            setPreviewFile(undefined);
            void openTask(taskId);
          }}
          onUseAsContext={(file) => {
            setPreviewFile(undefined);
            useFileAsContext(file);
          }}
        />
      </section>
    </main>
  );
}
