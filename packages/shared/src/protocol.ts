export type UserRole = 'user' | 'admin';

export type User = {
  id: string;
  username: string;
  name: string;
  email?: string;
  role: UserRole;
  createdAt: string;
};

export type AuthSession = {
  id: string;
  userId: string;
  token: string;
  createdAt: string;
  expiresAt?: string;
};

export type TaskStatus = 'created' | 'planning' | 'running' | 'waiting_approval' | 'completed' | 'failed';

export type TaskIntent = 'meeting' | 'business' | 'coding' | 'qa' | 'general';

export type MessageStatus = 'streaming' | 'completed' | 'failed';

export type MessagePlanStep = {
  id: string;
  text: string;
  status: 'pending' | 'running' | 'done' | 'error';
};

export type MessageToolCall = {
  id: string;
  name: string;
  arguments?: unknown;
  result?: string;
  isError?: boolean;
  status: 'running' | 'done' | 'error';
};

export type Task = {
  id: string;
  userId: string;
  agentId?: string;
  sessionKey?: string;
  title: string;
  userInput: string;
  intent: TaskIntent;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  userId: string;
  taskId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  contextFileIds?: string[];
  parentMessageId?: string;
  status?: MessageStatus;
  planSteps?: MessagePlanStep[];
  toolCalls?: MessageToolCall[];
  planFooter?: string;
  createdAt: string;
};

export type AgentEventStatus = 'pending' | 'running' | 'success' | 'error' | 'waiting';

export type AgentEvent = {
  id: string;
  userId: string;
  taskId: string;
  type: string;
  title: string;
  message?: string;
  status?: AgentEventStatus;
  payload?: unknown;
  createdAt: string;
};

export type ArtifactType = 'plan' | 'meeting_draft' | 'code_diff' | 'report' | 'tool_result' | 'final_answer';

export type ArtifactFormat = 'markdown' | 'json' | 'diff' | 'text';

export type FileAssetCategory =
  | 'documents'
  | 'spreadsheets'
  | 'images'
  | 'presentations'
  | 'reports'
  | 'code'
  | 'data'
  | 'others';

export type FileAssetSource = 'assistant_generated' | 'user_uploaded' | 'tool_output' | 'workspace_imported';

export type FilePermissionRole = 'viewer' | 'editor';

export type FilePermission = {
  id: string;
  fileId: string;
  versionGroupId?: string;
  principalType: 'user' | 'team' | 'public_link';
  principalId: string;
  role: FilePermissionRole;
  revokedAt?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt?: string;
};

export type FileActivityType =
  | 'created'
  | 'uploaded'
  | 'previewed'
  | 'downloaded'
  | 'used_in_chat'
  | 'updated'
  | 'deleted'
  | 'restored'
  | 'shared'
  | 'version_created';

export type FileActivity = {
  id: string;
  fileId: string;
  userId: string;
  type: FileActivityType;
  message: string;
  metadata?: unknown;
  createdAt: string;
};

export type FileFolder = {
  id: string;
  userId: string;
  name: string;
  parentFolderId?: string;
  createdAt: string;
  updatedAt: string;
};

export type FileFolderUpdateInput = {
  name?: string;
  parentFolderId?: string | null;
};

export type FileAsset = {
  id: string;
  userId: string;
  taskId?: string;
  messageId?: string;
  agentId?: string;
  artifactId?: string;
  versionGroupId: string;
  version: number;
  parentFileId?: string;
  folderId?: string;
  name: string;
  title: string;
  category: FileAssetCategory;
  source: FileAssetSource;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  contentHash?: string;
  duplicateOfFileId?: string;
  path: string;
  workspacePath: string;
  summary?: string;
  previewText?: string;
  tags?: string[];
  isFavorite?: boolean;
  deletedAt?: string;
  deletedBy?: string;
  permissions?: FilePermission[];
  createdAt: string;
  updatedAt: string;
};

export type FileAssetContent =
  | {
      file: FileAsset;
      kind: 'text';
      text: string;
    }
  | {
      file: FileAsset;
      kind: 'image';
      dataUrl: string;
    }
  | {
      file: FileAsset;
      kind: 'unsupported';
      message: string;
    };

export type FileAssetUploadInput = {
  name: string;
  content: string;
  encoding?: 'text' | 'base64';
  mimeType?: string;
  category?: FileAssetCategory;
  taskId?: string;
  folderId?: string;
  parentFileId?: string;
  title?: string;
  summary?: string;
  tags?: string[];
};

export type FileListResult = {
  files: FileAsset[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type FileAssetUpdateInput = {
  title?: string;
  summary?: string;
  folderId?: string | null;
  tags?: string[];
  isFavorite?: boolean;
};

export type FileBatchActionInput = {
  fileIds: string[];
  action: 'delete' | 'restore' | 'favorite' | 'unfavorite' | 'move';
  folderId?: string | null;
};

export type Artifact = {
  id: string;
  userId: string;
  taskId: string;
  type: ArtifactType;
  title: string;
  format: ArtifactFormat;
  content: unknown;
  fileAsset?: FileAsset;
  createdAt: string;
};

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type Approval = {
  id: string;
  userId: string;
  taskId: string;
  title: string;
  description: string;
  action: string;
  payload: unknown;
  status: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
};

export type StreamEvent =
  | { type: 'task.updated'; data: Task }
  | { type: 'message.created'; data: Message }
  | { type: 'message.updated'; data: Message }
  | { type: 'agent.event.created'; data: AgentEvent }
  | { type: 'agent.event.updated'; data: AgentEvent }
  | { type: 'artifact.created'; data: Artifact }
  | { type: 'file.asset.created'; data: FileAsset }
  | { type: 'approval.requested'; data: Approval }
  | { type: 'approval.updated'; data: Approval };

export type LoginResponse = {
  token: string;
  user: User;
  agent?: Agent;
};

export type RegisterInput = {
  username: string;
  name?: string;
  password: string;
};

export type LoginInput = {
  username: string;
  password: string;
};

export type AgentStatus = 'offline' | 'idle' | 'running' | 'error';

export type AgentAccessRole = 'admin' | 'user';

export type AgentIdentity = {
  displayName: string;
  role: string;
  organization?: string;
  researchFields?: string[];
  experience?: 'beginner' | 'intermediate' | 'expert';
};

export type AgentRequirements = {
  tone?: '严谨学术' | '工程务实' | '简洁高效';
  depth?: '快速概览' | '标准分析' | '深度研究';
  language?: 'zh-CN' | 'en';
  autoMode?: boolean;
  expertDomains?: string[];
  notificationPrefs?: {
    wechat?: boolean;
    email?: boolean;
  };
};

export type XuanzhiAgentProfile = {
  version: 1;
  agentName: string;
  identity: AgentIdentity;
  requirements: AgentRequirements;
  access: {
    role: AgentAccessRole;
    isolatedWorkspace: boolean;
  };
};

export type Agent = {
  id: string;
  userId: string;
  name: string;
  gatewayAgentId: string | null;
  workspace: string;
  sessionKey: string;
  status: AgentStatus;
  profile?: XuanzhiAgentProfile | null;
  emoji?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionInfo = {
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  title: string;
  status: string;
  totalTokens?: number;
  estimatedCostUsd?: number;
  runtimeMs?: number;
  modelProvider?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  parentSessionKey?: string;
  childSessions?: string[];
  createdAt: string;
  updatedAt: string;
};

export type SessionMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  parentMessageId?: string;
  toolCalls?: MessageToolCall[];
  createdAt: string;
};
