import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readAll = async (...paths) => (await Promise.all(paths.map((path) => read(path)))).join('\n');
const assistantStyleModules = [
  'src/styles/assistant.css',
  'src/styles/assistant/shell.css',
  'src/styles/assistant/sidebar.css',
  'src/styles/assistant/agent-create.css',
  'src/styles/assistant/file-space.css',
  'src/styles/assistant/settings.css',
  'src/styles/assistant/responsive.css',
];
const readAssistantStyles = () => readAll(...assistantStyleModules);
const exists = async (path) => {
  try {
    await access(new URL(`../${path}`, import.meta.url));
    return true;
  } catch {
    return false;
  }
};

test('assistant shell exposes the QClaw-style workspace structure', async () => {
  const sidebar = await read('src/components/assistant/Sidebar.tsx');
  const header = await read('src/components/assistant/WorkspaceHeader.tsx');
  const assistantCss = await readAssistantStyles();

  assert.match(sidebar, /assistant-nav-rail/, 'expected a narrow navigation rail in the sidebar');
  assert.match(sidebar, /key:\s*'chat'/, 'expected chat to remain in the rail');
  assert.match(sidebar, /key:\s*'file'/, 'expected files to remain in the rail');
  assert.doesNotMatch(sidebar, /key:\s*'(expert|task|connect|memory|lab)'/, 'expected only chat and files in the rail');
  assert.match(sidebar, /nav-rail-bottom/, 'expected the bottom settings entry to remain');
  assert.match(sidebar, /nav-rail-icon/, 'expected the bottom settings icon to remain');
  assert.doesNotMatch(sidebar, /<BrandLockup \/>/, 'expected the sidebar brand lockup to be removed');
  assert.match(sidebar, /collapsed-toolbar-button/, 'expected collapsed sidebar toolbar buttons');
  assert.match(assistantCss, /\.assistant-sidebar\.is-rail-only \.collapsed-toolbar-button/, 'expected collapsed state to reveal rail toolbar actions');
  assert.match(sidebar, /collapsed-new-chat-button/, 'expected collapsed new-chat action to live in the sidebar rail');
  assert.doesNotMatch(header, /collapsed-new-chat-wrap|collapsed-new-chat-trigger/, 'expected no duplicate collapsed new-chat action in the workspace header');
  assert.doesNotMatch(assistantCss, /\.collapsed-new-chat-wrap|\.collapsed-new-chat-trigger/, 'expected duplicate header new-chat styles to be removed');
  assert.match(assistantCss, /--nav-rail-width:\s*68px/, 'expected a fixed narrow rail token');
  assert.match(assistantCss, /grid-template-columns:\s*var\(--nav-rail-width\) var\(--agent-sidebar-width\)/, 'expected rail + agent list columns');
});

test('settings dialog is promoted to a static settings center', async () => {
  const sidebar = await read('src/components/assistant/Sidebar.tsx');
  const assistantCss = await readAssistantStyles();

  assert.match(sidebar, /settings-shell/, 'expected settings center markup');
  assert.match(sidebar, /settings-menu-item is-active/, 'expected a selected settings section');
  assert.match(sidebar, /settings-switch is-on/, 'expected static switch controls');
  assert.match(assistantCss, /settings-modal/, 'expected dedicated settings modal sizing');
});

test('rail avatar opens settings instead of the login dialog', async () => {
  const sidebar = await read('src/components/assistant/Sidebar.tsx');
  const assistantCss = await readAssistantStyles();

  assert.match(sidebar, /nav-avatar-trigger/, 'expected the rail avatar to be an account trigger');
  assert.match(sidebar, /setSettingsOpen\(true\)/, 'expected avatar click to open settings');
  assert.doesNotMatch(sidebar, /setAccountLoginOpen|AccountLoginDialog|account-login-shell/, 'expected the login dialog code to be removed from the sidebar');
  assert.doesNotMatch(sidebar, /aria-label="账户菜单"/, 'expected the footer ellipsis account trigger to be removed');
  assert.doesNotMatch(sidebar, /sidebar-footer/, 'expected the footer account block to be removed');
  assert.doesNotMatch(assistantCss, /account-login-/, 'expected account login modal styling to be removed');
});

test('conversation list uses inline pending spinners instead of status groups', async () => {
  const sidebar = await read('src/components/assistant/Sidebar.tsx');
  const assistantCss = await readAssistantStyles();

  assert.doesNotMatch(sidebar, /groupable=/, 'expected status grouping to be removed');
  assert.doesNotMatch(sidebar, /group:\s*taskStatusMeta/, 'expected conversation items not to assign status groups');
  assert.doesNotMatch(sidebar, /已完成/, 'expected completed group label to be removed from sidebar logic');
  assert.match(sidebar, /hasActiveTask/, 'expected the agent card to know when any task is active');
  assert.match(sidebar, /agent-card-spinner/, 'expected the active agent avatar to render a spinner badge');
  assert.match(sidebar, /conversation-item-spinner/, 'expected active conversation items to render a leading spinner');
  assert.doesNotMatch(sidebar, /conversation-title-spinner/, 'expected active conversation items not to render duplicate tail spinners');
  assert.doesNotMatch(sidebar, /task\.status !== 'completed'/, 'expected failed or cancelled terminal tasks not to spin');
  assert.match(sidebar, /isTaskActive\(task\.status\)/, 'expected spinner visibility to use an active-task helper');

  const activeStatusList = sidebar.match(/activeTaskStatuses = new Set<Task\['status'\]>\(\[(?<statuses>[\s\S]*?)\]\)/);
  assert.ok(activeStatusList?.groups?.statuses, 'expected an explicit active task status list');
  assert.match(activeStatusList.groups.statuses, /'created'/, 'expected newly created tasks to show pending indicator');
  assert.match(activeStatusList.groups.statuses, /'planning'/, 'expected planning tasks to show pending indicator');
  assert.match(activeStatusList.groups.statuses, /'running'/, 'expected running tasks to show pending indicator');
  assert.match(activeStatusList.groups.statuses, /'waiting_approval'/, 'expected approval-waiting tasks to show pending indicator');
  assert.doesNotMatch(activeStatusList.groups.statuses, /'completed'|'failed'/, 'expected terminal tasks to hide pending indicator');
  assert.match(assistantCss, /agent-card-spinner/, 'expected active agent avatar spinner styling in CSS');
  assert.match(assistantCss, /conversation-item-spinner/, 'expected active conversation icon spinner styling in CSS');
  assert.match(
    assistantCss,
    /\.conversation-title\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/,
    'expected conversation titles to keep the title text in the flexible first column',
  );
});

test('task execution workspace is removed from the basic chat surface', async () => {
  const shell = await read('src/components/assistant/AssistantShell.tsx');
  const header = await read('src/components/assistant/WorkspaceHeader.tsx');
  const chatPanel = await read('src/components/chat/ChatPanel.tsx');
  const assistantCss = await readAssistantStyles();
  const chatCss = await read('src/styles/chat.css');

  assert.doesNotMatch(shell, /AgentWorkspace/, 'expected the right task workspace component to be removed from the shell');
  assert.doesNotMatch(shell, /workspaceCollapsed|toggleWorkspace|task-workspace|TaskArtifactPanel|has-artifacts/, 'expected right workspace and artifact panel state to be removed');
  assert.match(shell, /className="task-chat-column"/, 'expected the active chat to render as a single chat column');
  assert.doesNotMatch(header, /workspaceCollapsed|onToggleWorkspace|workspace-toggle/, 'expected the header not to expose a workspace toggle');
  assert.doesNotMatch(header, /pendingApprovalCount|pendingApprovalSummaries|pending-approval-button/, 'expected global header approval entry to be removed');
  assert.doesNotMatch(shell, /pendingApprovalSummaries|pendingApprovalCount/, 'expected approval prompts to stay scoped to the active chat');
  assert.doesNotMatch(chatPanel, /AgentTimeline|ArtifactPanel/, 'expected progress and artifact modules to be removed from the chat panel');
  assert.doesNotMatch(chatPanel, /events|artifacts|inline-task-activity|inline-final-artifacts/, 'expected the chat panel to keep only the basic message surface');
  assert.doesNotMatch(shell, /activeEvents|activeArtifacts|activeTaskFinished/, 'expected task progress and artifact view state to be removed');
  assert.doesNotMatch(shell, /getTaskEvents|getTaskArtifacts|artifactsByTask/, 'expected artifact snapshot loading to be removed');
  assert.match(shell, /activePendingApprovals/, 'expected pending approvals to be derived for the active chat');
  assert.match(shell, /composer-approval-stack/, 'expected approval prompts above the composer');
  assert.equal(await exists('src/components/agent/AgentWorkspace.tsx'), false, 'expected the old right workspace component file to be deleted');
  assert.equal(await exists('src/components/agent/AgentTimeline.tsx'), false, 'expected the inline progress component file to be deleted');
  assert.equal(await exists('src/components/artifacts/ArtifactPanel.tsx'), false, 'expected the artifact panel component file to be deleted');
  assert.equal(await exists('src/components/artifacts/ArtifactViewer.tsx'), false, 'expected the artifact viewer component file to be deleted');
  assert.doesNotMatch(chatCss, /inline-task-activity|inline-final-artifacts/, 'expected inline progress and artifact chat styles to be deleted');
  assert.match(chatCss, /composer-approval-stack/, 'expected composer approval prompt styles');
  assert.doesNotMatch(assistantCss, /agent-progress|agent-tool-call|agent-workspace|task-workspace|artifact-panel|artifact-viewer/, 'expected unused workspace, progress, and artifact styles to be deleted');
});

test('chat messages and composer share one horizontal alignment contract', async () => {
  const shell = await read('src/components/assistant/AssistantShell.tsx');
  const assistantCss = await readAssistantStyles();
  const chatCss = await read('src/styles/chat.css');

  assert.doesNotMatch(shell, /TaskArtifactPanel|task-workspace|has-artifacts/, 'expected no right artifact panel or two-column task workspace');
  assert.match(shell, /className="task-chat-column"/, 'expected chat content to stay in the single aligned chat column');
  assert.match(assistantCss, /--chat-inline-padding:\s*24px/, 'expected chat body and composer to share an inline padding token');
  assert.match(
    assistantCss,
    /\.workspace-body\.is-task\s*\{[\s\S]*padding:\s*0\s+var\(--chat-inline-padding\)/,
    'expected task message body to use the shared inline padding',
  );
  assert.match(
    chatCss,
    /\.assistant-main\.is-chatting \.composer-area\s*\{[\s\S]*padding:\s*12px\s+var\(--chat-inline-padding\)\s+22px/,
    'expected composer area to use the same shared inline padding as the message body',
  );
  assert.match(
    chatCss,
    /\.chat-canvas\s*\{[\s\S]*width:\s*100%[\s\S]*margin:\s*0/,
    'expected message list to fill the aligned chat column instead of recentering independently',
  );
  assert.match(
    chatCss,
    /\.composer-stack\s*\{[\s\S]*width:\s*min\(var\(--chat-surface-width\),\s*100%\)[\s\S]*margin:\s*0 auto/,
    'expected composer stack to use the same chat surface width as the chat column',
  );
});

test('task streams are isolated when switching conversations', async () => {
  const shell = await read('src/components/assistant/AssistantShell.tsx');
  const chatCanvas = await read('src/components/chat/ChatCanvas.tsx');

  assert.match(shell, /streamGenerationRef/, 'expected stream subscriptions to use a generation guard');
  assert.match(shell, /getStreamEventTaskId/, 'expected stream events to be checked against their source task');
  assert.match(shell, /eventTaskId !== taskId/, 'expected stale task stream events to be ignored');
  assert.match(shell, /streamGeneration !== streamGenerationRef\.current/, 'expected late async stream setup to be ignored');
  assert.match(shell, /case 'message\.updated'/, 'expected streamed assistant message updates to be merged into the active task');
  assert.doesNotMatch(chatCanvas, /typing:\s*\{\s*effect:\s*'typing'/, 'expected historical assistant messages not to replay typing on conversation switch');
});

test('chat canvas stays pinned to the latest message while streaming', async () => {
  const chatCanvas = await read('src/components/chat/ChatCanvas.tsx');
  const chatCss = await read('src/styles/chat.css');

  assert.match(chatCanvas, /bottomAnchorRef/, 'expected a bottom scroll anchor for restored conversations');
  assert.match(chatCanvas, /scrollIntoView\(\{\s*block:\s*'end'\s*\}\)/, 'expected message updates to scroll to the bottom');
  assert.match(chatCanvas, /messageScrollKey/, 'expected streaming content changes to trigger bottom scrolling');
  assert.match(chatCanvas, /ResizeObserver/, 'expected growing assistant content to keep following the bottom');
  assert.match(chatCanvas, /isPinnedToBottomRef/, 'expected resize scrolling to avoid stealing the viewport while reading history');
  assert.match(chatCss, /chat-scroll-anchor/, 'expected the bottom anchor to have stable layout styling');
});

test('assistant messages render model markdown instead of raw markdown text', async () => {
  const chatCanvas = await read('src/components/chat/ChatCanvas.tsx');
  const assistantMessage = await read('src/components/chat/AssistantMessageContent.tsx');
  const markdownContentExists = await exists('src/components/chat/MarkdownContent.tsx');
  const chatCss = await read('src/styles/chat.css');

  assert.equal(markdownContentExists, true, 'expected a dedicated assistant markdown renderer component');
  const markdownContent = await read('src/components/chat/MarkdownContent.tsx');
  assert.match(markdownContent, /@ant-design\/x-markdown/, 'expected the renderer to use @ant-design/x-markdown');
  assert.match(markdownContent, /className="assistant-markdown"/, 'expected XMarkdown to receive the assistant markdown class');
  assert.match(markdownContent, /content=\{content\}/, 'expected XMarkdown to receive the assistant content');
  assert.match(markdownContent, /hasMarkdownSyntax/, 'expected plain assistant text to be detected before markdown rendering');
  assert.match(markdownContent, /assistant-plain-text/, 'expected short plain assistant messages to have a non-markdown fallback');
  assert.match(markdownContent, /hasNextChunk:\s*streaming/, 'expected XMarkdown streaming to track the live message state');
  assert.match(markdownContent, /tail:\s*streaming/, 'expected XMarkdown to show a streaming tail only for live messages');
  assert.match(chatCanvas, /<AssistantMessageContent message=\{message\}/, 'expected assistant messages to use the custom renderer');
  assert.match(assistantMessage, /<MarkdownContent content=\{finalAnswer\}/, 'expected final answers to use MarkdownContent');
  assert.match(assistantMessage, /streaming=\{message\.status === 'streaming'\}/, 'expected assistant message status to enable streaming markdown');
  assert.match(chatCanvas, /message\.role === 'assistant'/, 'expected markdown rendering to be scoped to assistant messages');
  assert.match(chatCss, /assistant-markdown/, 'expected markdown content styles');
  assert.match(chatCss, /assistant-plain-text/, 'expected plain assistant text fallback styles');
  assert.match(chatCss, /white-space:\s*pre-wrap/, 'expected plain assistant messages to preserve line breaks');
  assert.match(chatCss, /assistant-markdown strong/, 'expected bold markdown styling');
  assert.match(chatCss, /assistant-markdown ol/, 'expected ordered-list markdown styling');
});

test('assistant execution details are normalized into user-facing message sections', async () => {
  const chatCanvas = await read('src/components/chat/ChatCanvas.tsx');
  const assistantMessageExists = await exists('src/components/chat/AssistantMessageContent.tsx');
  const executionSummaryExists = await exists('src/components/chat/AgentExecutionSummary.tsx');
  const codeCardExists = await exists('src/components/chat/CodeCard.tsx');
  const runResultExists = await exists('src/components/chat/RunResult.tsx');
  const normalizeExists = await exists('src/utils/agentMessage.ts');
  const chatCss = await read('src/styles/chat.css');

  assert.equal(assistantMessageExists, true, 'expected a dedicated assistant message renderer');
  assert.equal(executionSummaryExists, true, 'expected a reusable execution summary component');
  assert.equal(codeCardExists, true, 'expected fenced code to render as code cards');
  assert.equal(runResultExists, true, 'expected command output to render outside code blocks');
  assert.equal(normalizeExists, true, 'expected a normalize layer before rendering raw agent events');

  const assistantMessage = await read('src/components/chat/AssistantMessageContent.tsx');
  const executionSummary = await read('src/components/chat/AgentExecutionSummary.tsx');
  const codeCard = await read('src/components/chat/CodeCard.tsx');
  const runResult = await read('src/components/chat/RunResult.tsx');
  const normalize = await read('src/utils/agentMessage.ts');

  assert.match(chatCanvas, /<AssistantMessageContent message=\{message\}/, 'expected assistant messages to use the custom renderer');
  assert.doesNotMatch(chatCanvas, /<MarkdownContent content=\{message\.content\}/, 'expected raw assistant content not to be rendered directly');

  assert.match(assistantMessage, /normalizeAgentMessage\(message\)/, 'expected renderer to normalize message content');
  assert.match(assistantMessage, /<AgentExecutionSummary steps=\{steps\}/, 'expected execution summary section');
  assert.match(assistantMessage, /<MarkdownContent content=\{finalAnswer\}/, 'expected final answer section');
  assert.match(assistantMessage, /<CodeCard/, 'expected code block section');
  assert.match(assistantMessage, /<RunResult/, 'expected run result section');

  assert.match(executionSummary, /已完成 \{completedCount\} 个步骤/, 'expected collapsed standard summary text');
  assert.match(executionSummary, /正在执行第 \{runningIndex \+ 1\} \/ \{steps\.length\} 个步骤/, 'expected running summary text');
  assert.match(executionSummary, /执行失败，已完成 \{completedCount\} \/ \{steps\.length\} 个步骤/, 'expected error summary text');
  assert.doesNotMatch(executionSummary, /未知操作完成|write完成|exec完成|exec: command run|Tool output/, 'expected standard UI not to expose raw debug labels');
  assert.match(executionSummary, /mode === 'debug'/, 'expected raw diagnostics to stay behind debug mode');

  assert.match(normalize, /formatAgentStep/, 'expected formatAgentStep utility');
  assert.match(normalize, /已完成一个系统步骤/, 'expected unknown steps to use a user-facing fallback');
  assert.match(normalize, /已创建或更新文件/, 'expected write events to be mapped');
  assert.match(normalize, /已执行命令/, 'expected exec events to be mapped');
  assert.match(normalize, /extractCodeBlocks/, 'expected code block extraction');
  assert.match(normalize, /extractRunResult/, 'expected run result extraction');
  assert.match(normalize, /context\\.compiled/, 'expected OpenClaw context trace lines to be filtered');
  assert.match(normalize, /tool_use\|tool_result/, 'expected raw OpenClaw tool trace lines to be filtered');
  assert.match(normalize, /tool_call\|function_call/, 'expected raw OpenClaw XML tool payloads to be filtered');
  assert.match(normalize, /stripRawToolPayloads/, 'expected raw tool payloads to be removed before rendering');
  assert.match(normalize, /rawMessage\.toolCalls/, 'expected structured OpenClaw tool calls to drive execution details');
  assert.match(normalize, /normalizeToolCallStep/, 'expected tool call blocks to normalize without text guessing');
  assert.doesNotMatch(normalize, /未知操作完成/, 'expected normalize layer not to emit unknown-operation copy');

  assert.match(codeCard, /复制/, 'expected code cards to include a copy action');
  assert.match(runResult, /运行成功|运行失败/, 'expected run result status labels');
  assert.match(chatCss, /agent-execution-summary/, 'expected execution summary styles');
  assert.match(chatCss, /code-card/, 'expected code card styles');
  assert.match(chatCss, /run-result/, 'expected run result styles');
});

test('assistant generated files render as downloadable cards and images use API preview URLs', async () => {
  const assistantMessageExists = await exists('src/components/chat/GeneratedFileList.tsx');
  const normalize = await read('src/utils/agentMessage.ts');
  const assistantMessage = await read('src/components/chat/AssistantMessageContent.tsx');
  const chatCss = await read('src/styles/chat.css');

  assert.equal(assistantMessageExists, true, 'expected generated file list component');
  const generatedFiles = await read('src/components/chat/GeneratedFileList.tsx');

  assert.match(normalize, /rewriteMarkdownAssetUrls/, 'expected markdown image and link URLs to be rewritten');
  assert.match(normalize, /extractGeneratedFiles/, 'expected local file references to be extracted');
  assert.match(normalize, /splitMarkdownAssetTarget/, 'expected markdown file paths with spaces or titles to be parsed');
  assert.doesNotMatch(normalize, /\[\^\)\\s\]\+/, 'expected markdown file paths not to reject spaces');
  assert.match(normalize, /\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/files/, 'expected task-owned file API URLs');
  assert.match(normalize, /params\.set\('inline', '1'\)/, 'expected image previews to request inline file rendering');
  assert.match(normalize, /token/, 'expected image preview URLs to carry user auth for img tags');

  assert.match(assistantMessage, /<GeneratedFileList files=\{generatedFiles\}/, 'expected assistant renderer to show generated files');
  assert.match(generatedFiles, /href=\{file\.downloadUrl\}/, 'expected generated files to be clickable downloads');
  assert.match(generatedFiles, /download=\{file\.name\}/, 'expected download attribute on generated file links');
  assert.match(generatedFiles, /<img/, 'expected generated image files to render previews');
  assert.match(chatCss, /generated-file-list/, 'expected generated file list styles');
  assert.match(chatCss, /generated-file-preview/, 'expected generated image preview styles');
});

test('PDF previews do not leak auth tokens through referrers or popup openers', async () => {
  const preview = await read('src/components/files/FilePreviewModal.tsx');

  assert.match(preview, /referrerPolicy="no-referrer"/, 'expected embedded PDF previews to suppress referrers');
  assert.match(preview, /noopener,noreferrer/, 'expected detached PDF previews to isolate the opener and suppress referrers');
});

test('assistant message components rerender when the login token changes', async () => {
  const app = await read('src/App.tsx');
  const shell = await read('src/components/assistant/AssistantShell.tsx');
  const chatPanel = await read('src/components/chat/ChatPanel.tsx');
  const chatCanvas = await read('src/components/chat/ChatCanvas.tsx');

  assert.match(app, /key=\{`\$\{currentUser\.id\}:\$\{token\}`\}/, 'expected AssistantShell to remount at auth boundaries');
  assert.match(shell, /renderKey=\{token\}/, 'expected the active auth token to flow into chat rendering');
  assert.match(chatPanel, /renderKey:\s*string/, 'expected ChatPanel to accept an auth-sensitive render key');
  assert.match(chatPanel, /<ChatCanvas[\s\S]*renderKey=\{renderKey\}/, 'expected ChatPanel to pass the render key through');
  assert.match(chatCanvas, /renderKey:\s*string/, 'expected ChatCanvas to accept an auth-sensitive render key');
  assert.match(chatCanvas, /\[messages,\s*onCopyMessage,\s*onEditMessage,\s*renderKey\]/, 'expected memoized assistant content to recompute after relogin');
});

test('composer keeps only base input actions without capability toggles', async () => {
  const composer = await read('src/components/chat/ChatComposer.tsx');
  const data = await read('src/data/assistantData.tsx');
  const chatCss = await read('src/styles/chat.css');

  assert.doesNotMatch(composer, /toolTags|sender-footer-tools|<Tag|<Space/, 'expected composer capability toggles to be removed');
  assert.doesNotMatch(data, /export const toolTags/, 'expected unused composer capability metadata to be deleted');
  assert.doesNotMatch(chatCss, /sender-footer-tools|sender-footer \.ant-tag/, 'expected deleted composer toggle styles not to remain');
  assert.match(composer, /sender-footer-actions/, 'expected base composer actions to remain');
  assert.match(composer, /paperclip/, 'expected attachment action to remain');
});

test('agent flow uses the backend-owned user agent and isolates conversations per agent', async () => {
  const shell = await read('src/components/assistant/AssistantShell.tsx');
  const sidebar = await read('src/components/assistant/Sidebar.tsx');
  const picker = await read('src/components/assistant/AgentCreatePage.tsx');
  const assistantCss = await readAssistantStyles();

  assert.match(shell, /DEFAULT_AGENT_ID/, 'expected a stable default agent identity');
  assert.match(shell, /agentApi\.listAgents/, 'expected agents to be loaded from the backend');
  assert.match(shell, /activeAgentId/, 'expected active agent selection state');
  assert.match(shell, /taskAgentMap/, 'expected tasks to be mapped to the owning agent');
  assert.match(shell, /activeAgentTasks/, 'expected the conversation list to be filtered by active agent');
  assert.match(shell, /showAgentCreatePage/, 'expected New Agent to route to the creation page');
  assert.match(shell, /<AgentCreatePage/, 'expected the agent creation page to render in the main workspace');

  assert.match(sidebar, /agentItems\.map/, 'expected the sidebar to render multiple agents');
  assert.match(sidebar, /onAgentSelect/, 'expected clicking an agent to switch agent context');
  assert.match(sidebar, /onCreateAgent/, 'expected the agent setup button to open the profile wizard instead of a blank chat');

  assert.match(picker, /agent-wizard-page/, 'expected a dedicated agent profile wizard surface');
  assert.match(picker, /saveProfile/, 'expected the wizard to update the backend-owned agent profile');
  assert.match(picker, /existingAgent/, 'expected the wizard to edit the current user agent');
  assert.match(assistantCss, /agent-wizard-page/, 'expected profile wizard layout styles');
  assert.match(assistantCss, /agent-list/, 'expected sidebar multi-agent list styles');
});

test('OpenClaw session behavior is added without replacing the main UI surface', async () => {
  const shell = await read('src/components/assistant/AssistantShell.tsx');
  const sidebar = await read('src/components/assistant/Sidebar.tsx');
  const composer = await read('src/components/chat/ChatComposer.tsx');
  const home = await read('src/components/chat/ChatHome.tsx');
  const agentApi = await read('src/services/agentApi.ts');
  const profilePanel = await read('src/components/assistant/AgentProfilePanel.tsx');

  assert.match(agentApi, /syncAgentProfile/, 'expected profile sync API client');
  assert.match(agentApi, /getOpenClawAgentProfile/, 'expected OpenClaw profile read API client');
  assert.match(agentApi, /openMainTask/, 'expected main OpenClaw task API client');
  assert.match(agentApi, /createConversation/, 'expected child conversation API client');

  assert.match(profilePanel, /getOpenClawAgentProfile/, 'expected settings profile panel to read OpenClaw files');
  assert.match(profilePanel, /syncAgentProfile/, 'expected settings profile panel to resync profile files');
  assert.match(profilePanel, /openclaw-profile-file-grid/, 'expected profile file status to use the existing settings styling surface');

  assert.match(shell, /function isMainTask/, 'expected main session tasks to be identified');
  assert.match(shell, /agentApi\.openMainTask/, 'expected clicking an agent to open its main task');
  assert.match(shell, /agentApi\.createConversation/, 'expected new conversations to create OpenClaw child sessions');
  assert.match(shell, /activeAgentTasks\.filter\(\(task\) => !isMainTask\(task\)\)/, 'expected main sessions to stay out of the normal conversation list');
  assert.match(shell, /submitCommand/, 'expected command messages to flow through the existing composer path');
  assert.match(shell, /command === '\/reset soft'/, 'expected soft reset to ask for confirmation before sending');
  assert.match(shell, /renderKey=\{token\}/, 'expected existing auth-sensitive chat renderer wiring to remain');

  assert.match(sidebar, /assistant-nav-rail/, 'expected existing sidebar rail UI to remain');
  assert.match(sidebar, /onAgentSelect/, 'expected existing agent-card click prop to remain');
  assert.doesNotMatch(sidebar, /onOpenAgentMain/, 'expected no pr-4 sidebar prop rename that rewrites the UI contract');

  assert.match(composer, /export type ComposerCommand/, 'expected composer command type');
  assert.match(composer, /'\/compact'/, 'expected compact command support');
  assert.match(composer, /'\/status'/, 'expected status command support');
  assert.match(composer, /'\/tools compact'/, 'expected compact tools command support');
  assert.match(composer, /'\/reset soft'/, 'expected soft reset command support');
  assert.match(composer, /agentName/, 'expected composer placeholder to use the active agent name');
  assert.match(composer, /sender-footer-actions/, 'expected existing composer actions to remain');
  assert.match(home, /onCommand/, 'expected home composer to pass command callbacks');
});

test('file workspace renders the screenshot-style file space', async () => {
  const shell = await read('src/components/assistant/AssistantShell.tsx');
  const sidebar = await read('src/components/assistant/Sidebar.tsx');
  const filePage = await read('src/components/files/FileSpacePage.tsx');
  const assistantCss = await readAssistantStyles();

  assert.match(sidebar, /activeWorkspace/, 'expected the sidebar rail to track the active workspace');
  assert.match(sidebar, /onWorkspaceChange/, 'expected rail items to switch workspaces');
  assert.doesNotMatch(sidebar, /key:\s*'file'[\s\S]*disabled:\s*true/, 'expected the file rail item to be enabled');
  assert.match(sidebar, /file-sidebar-panel/, 'expected a dedicated file-space sidebar panel');
  assert.match(sidebar, /file-category-list/, 'expected file categories in the sidebar');
  assert.match(sidebar, /文件空间/, 'expected the file sidebar title');

  assert.match(shell, /WorkspaceView = 'home' \| 'chat' \| 'agent-picker' \| 'file'/, 'expected file to be a workspace view');
  assert.match(shell, /showFileSpace/, 'expected a file workspace route handler');
  assert.match(shell, /<FileSpacePage/, 'expected the file space page to render in the main workspace');

  assert.match(filePage, /file-space-page/, 'expected a dedicated file page surface');
  assert.match(filePage, /搜索文件名/, 'expected the top file search input');
  assert.match(filePage, /全部Agent/, 'expected the agent filter control');
  assert.match(filePage, /\{visibleFiles\.length\} 个文件/, 'expected the dynamic file count');
  assert.match(filePage, /function groupTitle\(file: FileAsset\)/, 'expected grouped file source titles');
  assert.match(filePage, /<FileTypeMark file=\{file\}/, 'expected file rows to render typed file marks');
  assert.match(filePage, /file-view-toggle/, 'expected list/grid view controls');

  assert.match(assistantCss, /file-space-page/, 'expected file page layout styles');
  assert.match(assistantCss, /file-sidebar-panel/, 'expected file sidebar styles');
  assert.match(assistantCss, /file-card/, 'expected file card styles');
});

test('assistant styles are split by feature module', async () => {
  const assistantCss = await read('src/styles/assistant.css');
  const responsiveCss = await read('src/styles/responsive.css');

  assert.match(assistantCss, /@import '\.\/assistant\/shell\.css'/, 'expected shell styles to live in an assistant module');
  assert.match(assistantCss, /@import '\.\/assistant\/sidebar\.css'/, 'expected sidebar styles to live in an assistant module');
  assert.match(assistantCss, /@import '\.\/assistant\/agent-create\.css'/, 'expected agent creation styles to live in an assistant module');
  assert.match(assistantCss, /@import '\.\/assistant\/file-space\.css'/, 'expected file-space styles to live in an assistant module');
  assert.match(assistantCss, /@import '\.\/assistant\/settings\.css'/, 'expected settings styles to live in an assistant module');
  assert.match(responsiveCss, /@import '\.\/assistant\/responsive\.css'/, 'expected assistant responsive rules to load in the final responsive cascade');
  assert.ok(assistantCss.length < 500, 'expected assistant.css to be a small manifest, not a monolithic stylesheet');

  for (const path of assistantStyleModules.slice(1)) {
    assert.equal(await exists(path), true, `expected ${path} to exist`);
  }
});

test('home and chat styling follow the approved visual contract', async () => {
  const data = await read('src/data/assistantData.tsx');
  const chatCss = await read('src/styles/chat.css');
  const uiCss = await read('src/styles/ui.css');

  assert.match(data, /tone:\s*'lavender'/, 'expected colored prompt card metadata');
  assert.match(chatCss, /prompt-tone-lavender/, 'expected prompt tone styles');
  assert.doesNotMatch(chatCss, /inline-final-artifacts/, 'expected completed task artifacts to be removed from the chat flow');
  assert.match(uiCss, /--radius:\s*8px/, 'expected shadcn-like radius token');
  assert.match(uiCss, /--background:\s*#ffffff/, 'expected shadcn-like background token');
});
