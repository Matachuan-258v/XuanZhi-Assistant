import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { FastifyInstance } from 'fastify';
import type {
  AgentEvent,
  FileAsset,
  LoginResponse,
  Message,
  Task,
  TaskIntent,
  XuanzhiAgentProfile,
} from '@xuanzhi/shared/protocol';

const gateway = vi.hoisted(() => {
  type Handler = (payload: unknown) => void;

  const handlers = new Map<string, Set<Handler>>();
  const calls: Array<{ method: string; params?: unknown }> = [];
  const agents: Array<{ id: string; name: string; workspace: string }> = [];
  const sessions: Array<{ key: string; title: string; agentId: string; createdAt: string; updatedAt: string; parentSessionKey?: string }> = [];
  const agentFiles = new Map<string, string>();
  let agentSequence = 0;
  let shouldFailProfileWrites = false;

  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) {
      handler(payload);
    }
  };

  const client = {
    isConnected: vi.fn(() => true),
    connect: vi.fn(async () => undefined),
    request: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params });

      if (method === 'health') {
        return { ok: true, status: 'ok', agents: [] };
      }

      if (method === 'agents.list') {
        return { agents };
      }

      if (method === 'agents.create') {
        agentSequence += 1;
        const input = params as { workspace?: string };
        const agent = {
          id: `gateway-agent-${agentSequence}`,
          name: `gateway-agent-${agentSequence}`,
          workspace: input.workspace ?? `workspace-${agentSequence}`,
        };
        agents.push(agent);
        return {
          ok: true,
          agentId: agent.id,
          name: agent.name,
          workspace: agent.workspace,
        };
      }

      if (method === 'agents.files.set') {
        if (shouldFailProfileWrites) {
          throw new Error('profile write failed');
        }
        const input = params as { agentId: string; name: string; content: string };
        agentFiles.set(`${input.agentId}:${input.name}`, input.content);
        return { ok: true };
      }

      if (method === 'agents.files.get') {
        const input = params as { agentId: string; name: string };
        const content = agentFiles.get(`${input.agentId}:${input.name}`);
        return content ? { file: { name: input.name, content } } : { file: null };
      }

      if (method === 'agent.identity.get') {
        const input = params as { agentId: string };
        return { agentId: input.agentId, source: 'test-gateway' };
      }

      if (method === 'agents.update') {
        return { ok: true };
      }

      if (method === 'sessions.create') {
        const input = params as { key: string; agentId: string; label?: string; parentSessionKey?: string };
        const key = input.key === 'main'
          ? `agent:${input.agentId}:main`
          : `agent:${input.agentId}:${input.key}`;
        if (
          !sessions.some((session) => session.key === key)
          && input.label
          && sessions.some((session) => session.agentId === input.agentId && session.title === input.label)
        ) {
          throw new Error(`label already in use: ${input.label}`);
        }
        if (!sessions.some((session) => session.key === key)) {
          sessions.push({
            key,
            title: input.label ?? key,
            agentId: input.agentId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            parentSessionKey: input.parentSessionKey,
          });
        }
        return { key };
      }

      if (method === 'sessions.list') {
        return { sessions };
      }

      if (method === 'chat.send') {
        const input = params as { sessionKey: string; message: string };
        if (!sessions.some((session) => session.key === input.sessionKey)) {
          throw new Error(`unknown session: ${input.sessionKey}`);
        }
        const responseDelayMs = input.message.includes('Slow workspace run') ? 80 : 0;
        setTimeout(async () => {
          const [{ mkdirSync, writeFileSync }, { join }] = await Promise.all([
            import('node:fs'),
            import('node:path'),
          ]);
          const gatewayAgentId = input.sessionKey.split(':')[1];
          const workspace = agents.find((agent) => agent.id === gatewayAgentId)?.workspace;
          if (workspace && input.message.includes('Create filtered workspace files')) {
            mkdirSync(join(workspace, 'outputs'), { recursive: true });
            writeFileSync(join(workspace, 'outputs', 'report.pdf'), '%PDF-1.7 filtered report', 'utf8');
            writeFileSync(join(workspace, 'outputs', 'private.pem'), 'PRIVATE KEY', 'utf8');
            writeFileSync(join(workspace, 'SOUL.md'), '# system profile', 'utf8');
          }
          if (workspace && input.message.includes('Create duplicate reports')) {
            mkdirSync(join(workspace, 'first'), { recursive: true });
            mkdirSync(join(workspace, 'second'), { recursive: true });
            writeFileSync(join(workspace, 'first', 'report.txt'), 'first report', 'utf8');
            writeFileSync(join(workspace, 'second', 'report.txt'), 'second report', 'utf8');
          }
          if (workspace && input.message.includes('Create report v1')) {
            mkdirSync(join(workspace, 'outputs'), { recursive: true });
            writeFileSync(join(workspace, 'outputs', 'report.txt'), 'version one', 'utf8');
          }
          if (workspace && input.message.includes('Create report v2')) {
            mkdirSync(join(workspace, 'outputs'), { recursive: true });
            writeFileSync(join(workspace, 'outputs', 'report.txt'), 'version two', 'utf8');
          }
          if (workspace && input.message.includes('Slow workspace run')) {
            mkdirSync(join(workspace, 'outputs'), { recursive: true });
            writeFileSync(join(workspace, 'outputs', 'slow.txt'), 'slow result', 'utf8');
          }
          if (workspace && input.message.includes('Fast workspace run')) {
            mkdirSync(join(workspace, 'outputs'), { recursive: true });
            writeFileSync(join(workspace, 'outputs', 'fast.txt'), 'fast result', 'utf8');
          }
          if (input.message.includes('Disk failed tool')) {
            void (async () => {
              const [{ existsSync, mkdirSync, readFileSync, writeFileSync }, { join }] = await Promise.all([
                import('node:fs'),
                import('node:path'),
              ]);
              const gatewayAgentId = input.sessionKey.split(':')[1] ?? 'gateway-agent-1';
              const sessionsDir = join(process.env.OPENCLAW_WORKSPACE_ROOT!, 'agents', gatewayAgentId, 'sessions');
              const sessionId = 'disk-backfill-runtime-session';
              const indexPath = join(sessionsDir, 'sessions.json');
              mkdirSync(sessionsDir, { recursive: true });
              const currentIndex = existsSync(indexPath)
                ? JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>
                : {};
              writeFileSync(
                indexPath,
                JSON.stringify({
                  ...currentIndex,
                  [input.sessionKey]: {
                    key: input.sessionKey,
                    sessionId,
                    title: 'Disk failed tool',
                    status: 'completed',
                    updatedAt: Date.now(),
                    sessionStartedAt: Date.now(),
                  },
                }),
                'utf8',
              );
              writeFileSync(
                join(sessionsDir, `${sessionId}.jsonl`),
                [
                  JSON.stringify({
                    type: 'message',
                    id: 'disk-runtime-user',
                    timestamp: new Date().toISOString(),
                    message: { role: 'user', content: [{ type: 'text', text: input.message }] },
                  }),
                  JSON.stringify({
                    type: 'message',
                    id: 'disk-runtime-assistant',
                    parentId: 'disk-runtime-user',
                    timestamp: new Date(Date.now() + 1).toISOString(),
                    message: {
                      role: 'assistant',
                      content: [
                        { type: 'text', text: 'Runtime disk answer.' },
                        { type: 'toolCall', id: 'tool-disk-fail', name: 'web_fetch', arguments: { url: 'https://example.com' } },
                      ],
                    },
                  }),
                  JSON.stringify({
                    type: 'message',
                    id: 'disk-runtime-result',
                    parentId: 'disk-runtime-assistant',
                    timestamp: new Date(Date.now() + 2).toISOString(),
                    message: {
                      role: 'toolResult',
                      toolCallId: 'tool-disk-fail',
                      toolName: 'web_fetch',
                      content: [{ type: 'text', text: '{"status":"error","error":"blocked"}' }],
                      isError: true,
                    },
                  }),
                ].join('\n'),
                'utf8',
              );
            })();
          }
          if (input.message.includes('Mirror tool')) {
            emit('agent', {
              sessionKey: input.sessionKey,
              stream: 'tool_call',
              data: {
                toolCallId: `tool-${Date.now()}`,
                toolName: 'read',
                path: 'IDENTITY.md',
              },
            });
          }
          if (input.message.includes('Realtime failed tool')) {
            emit('agent', {
              sessionKey: input.sessionKey,
              stream: 'tool_call',
              data: {
                toolCallId: 'tool-realtime-fail',
                toolName: 'web_search',
                query: 'latest docs',
              },
            });
            setTimeout(() => {
              emit('agent', {
                sessionKey: input.sessionKey,
                stream: 'tool_result',
                data: {
                  toolCallId: 'tool-realtime-fail',
                  toolName: 'web_search',
                  result: '{"status":"error","error":"missing_api_key"}',
                },
              });
            }, 10);
          }
          const payload: {
            runId: string;
            sessionKey?: string;
            seq: number;
            state: 'final';
            message: { role: string; content: Array<{ type: string; text: string }> };
          } = {
            runId: `run-${Date.now()}`,
            seq: 1,
            state: 'final',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: `OpenClaw response: ${input.message}`,
                },
              ],
            },
          };
          if (!input.message.includes('无 sessionKey 事件')) {
            payload.sessionKey = input.sessionKey;
          }
          emit('chat', payload);
        }, 0);
        return { ok: true };
      }

      return { ok: true };
    }),
    on: vi.fn((event: string, handler: Handler) => {
      if (!handlers.has(event)) {
        handlers.set(event, new Set());
      }
      handlers.get(event)!.add(handler);
      return () => {
        handlers.get(event)?.delete(handler);
      };
    }),
    getConnectionStatus: vi.fn(() => ({
      status: 'connected',
      health: 'healthy',
      connectedAt: Date.now(),
      lastHealthCheck: Date.now(),
      lastHealthOk: true,
      consecutiveHealthFailures: 0,
      gatewayVersion: 'test',
      gatewayHost: '127.0.0.1',
      agents: agentSequence,
      deviceId: 'test-device',
      hasDeviceToken: true,
      lastError: null,
    })),
  };

  return {
    calls,
    client,
    reset() {
      calls.length = 0;
      agents.length = 0;
      sessions.length = 0;
      agentFiles.clear();
      handlers.clear();
      agentSequence = 0;
      shouldFailProfileWrites = false;
      client.isConnected.mockClear();
      client.connect.mockClear();
      client.request.mockClear();
      client.on.mockClear();
      client.getConnectionStatus.mockClear();
    },
    failProfileWrites() {
      shouldFailProfileWrites = true;
    },
  };
});

vi.mock('../src/agents/openclawClient.js', () => ({
  getOpenClawClient: () => gateway.client,
}));

const { buildApp } = await import('../src/app.js');
const { createXuanzhiWorkspacePath } = await import('../src/agents/workspace.js');

async function login(app: FastifyInstance, username: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      username,
      password: 'dev-password',
    },
  });

  expect(response.statusCode).toBe(200);
  return response.json<LoginResponse>();
}

async function createTask(
  app: FastifyInstance,
  token: string,
  userInput: string,
  options: { intent?: TaskIntent; title?: string } = {},
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      title: options.title ?? userInput.trim().slice(0, 28),
      userInput,
      intent: options.intent ?? 'general',
      userId: 'spoofed-user',
    },
  });

  expect(response.statusCode).toBe(201);
  return response.json<Task>();
}

async function sendUserMessage(
  app: FastifyInstance,
  token: string,
  taskId: string,
  content: string,
  contextFileIds?: string[],
) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/messages`,
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      role: 'user',
      content,
      contextFileIds,
    },
  });

  expect(response.statusCode).toBe(201);
  return response.json<Message>();
}

const testProfile: XuanzhiAgentProfile = {
  version: 1,
  agentName: '张三的玄知助理',
  identity: {
    displayName: '张三',
    role: '密评工程师',
    organization: '玄知实验室',
    researchFields: ['密评合规', 'SM 系列算法'],
    experience: 'expert',
  },
  requirements: {
    tone: '工程务实',
    depth: '深度研究',
    language: 'zh-CN',
    autoMode: true,
    expertDomains: ['密码协议'],
    notificationPrefs: { wechat: true, email: false },
  },
  access: {
    role: 'user',
    isolatedWorkspace: true,
  },
};

async function waitForCondition(assertion: () => void | Promise<void>) {
  let lastError: unknown;
  for (let index = 0; index < 100; index += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe('xuanzhi api with OpenClaw Gateway', () => {
  let app: FastifyInstance;
  let workspaceRoot: string;
  let previousWorkspaceRoot: string | undefined;

  beforeEach(async () => {
    previousWorkspaceRoot = process.env.OPENCLAW_WORKSPACE_ROOT;
    workspaceRoot = mkdtempSync(join(tmpdir(), 'xuanzhi-workspace-'));
    process.env.OPENCLAW_WORKSPACE_ROOT = workspaceRoot;
    gateway.reset();
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (previousWorkspaceRoot === undefined) {
      delete process.env.OPENCLAW_WORKSPACE_ROOT;
    } else {
      process.env.OPENCLAW_WORKSPACE_ROOT = previousWorkspaceRoot;
    }
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('authenticates test users and returns the user agent', async () => {
    const { token, user, agent } = await login(app, 'alice');

    expect(agent).toMatchObject({
      userId: user.id,
      workspace: createXuanzhiWorkspacePath(user.username),
    });

    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json<LoginResponse>()).toMatchObject({
      user: {
        id: user.id,
        username: 'alice',
      },
      agent: {
        userId: user.id,
      },
    });
  });

  it('creates an isolated local agent during registration and defers Gateway creation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'new-user',
        name: 'New User',
        password: 'dev-password',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<LoginResponse>();
    expect(body.agent).toMatchObject({
      userId: body.user.id,
      gatewayAgentId: null,
      workspace: createXuanzhiWorkspacePath(body.user.username),
    });
    expect(gateway.calls.some((call) => call.method === 'agents.create')).toBe(false);
    expect(gateway.calls.some((call) => call.method === 'agents.update')).toBe(false);
  });

  it('binds tasks to currentUser and keeps task lists isolated', async () => {
    const userA = await login(app, 'alice');
    const userB = await login(app, 'bob');

    const taskA = await createTask(app, userA.token, 'Summarize document A');
    const taskB = await createTask(app, userB.token, 'Summarize document B');

    expect(taskA.userId).toBe(userA.user.id);
    expect(taskB.userId).toBe(userB.user.id);

    const tasksAResponse = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: {
        authorization: `Bearer ${userA.token}`,
      },
    });
    const tasksBResponse = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: {
        authorization: `Bearer ${userB.token}`,
      },
    });

    expect(tasksAResponse.json<Task[]>()).toHaveLength(1);
    expect(tasksAResponse.json<Task[]>()[0].id).toBe(taskA.id);
    expect(tasksBResponse.json<Task[]>()).toHaveLength(1);
    expect(tasksBResponse.json<Task[]>()[0].id).toBe(taskB.id);

    const forbiddenDetail = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskB.id}`,
      headers: {
        authorization: `Bearer ${userA.token}`,
      },
    });

    expect(forbiddenDetail.statusCode).toBe(404);
  });

  it('keeps user agent lists isolated between accounts', async () => {
    const userA = await login(app, 'alice');
    const userB = await login(app, 'bob');

    const [agentsAResponse, agentsBResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/api/agents',
        headers: { authorization: `Bearer ${userA.token}` },
      }),
      app.inject({
        method: 'GET',
        url: '/api/agents',
        headers: { authorization: `Bearer ${userB.token}` },
      }),
    ]);

    expect(agentsAResponse.statusCode).toBe(200);
    expect(agentsBResponse.statusCode).toBe(200);

    const agentsA = agentsAResponse.json<LoginResponse['agent'][]>();
    const agentsB = agentsBResponse.json<LoginResponse['agent'][]>();

    expect(agentsA).toHaveLength(1);
    expect(agentsB).toHaveLength(1);
    expect(agentsA[0]).toMatchObject({
      userId: userA.user.id,
      workspace: createXuanzhiWorkspacePath(userA.user.username),
    });
    expect(agentsB[0]).toMatchObject({
      userId: userB.user.id,
      workspace: createXuanzhiWorkspacePath(userB.user.username),
    });
    expect(agentsA[0]?.id).not.toBe(agentsB[0]?.id);
  });

  it('dispatches user messages to OpenClaw sessions and stores the assistant reply', async () => {
    const userA = await login(app, 'alice');
    await app.inject({
      method: 'PATCH',
      url: `/api/agents/${userA.agent?.id}/profile`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { profile: testProfile },
    });
    const task = await createTask(app, userA.token, 'Explain the uploaded notes');

    await sendUserMessage(app, userA.token, task.id, task.userInput);

    await waitForCondition(async () => {
      const taskResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(taskResponse.json<Task>().status).toBe('completed');
    });

    const [messagesResponse, eventsResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/messages`,
        headers: { authorization: `Bearer ${userA.token}` },
      }),
      app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/events`,
        headers: { authorization: `Bearer ${userA.token}` },
      }),
    ]);

    const messages = messagesResponse.json<Message[]>();
    const events = eventsResponse.json<AgentEvent[]>();

    expect(gateway.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining(['agents.create', 'agents.files.set', 'sessions.create', 'chat.send']),
    );
    const fileSetCalls = gateway.calls.filter((call) => call.method === 'agents.files.set');
    expect(fileSetCalls.map((call) => (call.params as { name: string }).name)).toEqual(
      expect.arrayContaining(['USER.md', 'AGENTS.md', 'IDENTITY.md', 'SOUL.md']),
    );
    expect(JSON.stringify(fileSetCalls.map((call) => call.params))).toContain('张三');
    expect(JSON.stringify(fileSetCalls.map((call) => call.params))).toContain('密评工程师');
    const chatSendCall = gateway.calls.find((call) => call.method === 'chat.send');
    expect(chatSendCall?.params).toMatchObject({
      message: 'Explain the uploaded notes',
    });
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'completed',
    });
    expect(messages.at(-1)?.content).toContain('Explain the uploaded notes');
    expect(events.map((event) => event.type)).toContain('agent.answer.created');
  });

  it('syncs and reads all OpenClaw agent profile bootstrap files', async () => {
    const userA = await login(app, 'alice');
    const agentId = userA.agent?.id;
    expect(agentId).toBeTruthy();

    await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/profile`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { profile: testProfile },
    });

    const syncResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/sync-profile`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(syncResponse.statusCode).toBe(200);

    const profileResponse = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/openclaw-profile`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(profileResponse.statusCode).toBe(200);
    const body = profileResponse.json<{
      files: Array<{ name: string; available: boolean; content: string }>;
      bootstrapFiles: string[];
    }>();

    expect(body.bootstrapFiles).toEqual(['USER.md', 'AGENTS.md', 'IDENTITY.md', 'SOUL.md']);
    expect(body.files.map((file) => file.name)).toEqual(body.bootstrapFiles);
    expect(body.files.every((file) => file.available)).toBe(true);
    expect(body.files.find((file) => file.name === 'IDENTITY.md')?.content).toContain(testProfile.agentName);
    expect(body.files.find((file) => file.name === 'SOUL.md')?.content).toContain('Default language');
  });

  it('continues chat when profile file sync fails', async () => {
    gateway.failProfileWrites();
    const userA = await login(app, 'alice');
    await app.inject({
      method: 'PATCH',
      url: `/api/agents/${userA.agent?.id}/profile`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { profile: testProfile },
    });
    const task = await createTask(app, userA.token, 'Continue even if profile sync fails');

    await sendUserMessage(app, userA.token, task.id, task.userInput);

    await waitForCondition(async () => {
      const taskResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(taskResponse.json<Task>().status).toBe('completed');
    });

    const [messagesResponse, eventsResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/messages`,
        headers: { authorization: `Bearer ${userA.token}` },
      }),
      app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/events`,
        headers: { authorization: `Bearer ${userA.token}` },
      }),
    ]);

    expect(messagesResponse.json<Message[]>().at(-1)?.content).toContain('Continue even if profile sync fails');
    expect(eventsResponse.json<AgentEvent[]>().map((event) => event.type)).toEqual(
      expect.arrayContaining(['agent.profile.sync_skipped', 'agent.answer.created']),
    );
    expect(gateway.calls.map((call) => call.method)).toContain('chat.send');
  });

  it('reuses the user agent for follow-up messages', async () => {
    const userA = await login(app, 'alice');
    const task = await createTask(app, userA.token, 'Start a research thread');

    await sendUserMessage(app, userA.token, task.id, task.userInput);
    await waitForCondition(async () => {
      const taskResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(taskResponse.json<Task>().status).toBe('completed');
    });

    await sendUserMessage(app, userA.token, task.id, 'Add implementation risks');
    await waitForCondition(async () => {
      const messagesResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/messages`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(messagesResponse.json<Message[]>()).toHaveLength(4);
    });

    const agentCreateCalls = gateway.calls.filter((call) => call.method === 'agents.create');
    const chatSendCalls = gateway.calls.filter((call) => call.method === 'chat.send');

    expect(agentCreateCalls).toHaveLength(1);
    expect(chatSendCalls).toHaveLength(2);
  });

  it('projects OpenClaw sessions back into the task list after API state is rebuilt', async () => {
    const userA = await login(app, 'alice');
    const task = await createTask(app, userA.token, 'Persist this OpenClaw session');

    await sendUserMessage(app, userA.token, task.id, task.userInput);
    await waitForCondition(async () => {
      const taskResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(taskResponse.json<Task>().status).toBe('completed');
    });

    await app.close();
    app = buildApp();
    await app.ready();

    const restoredUser = await login(app, 'alice');
    const restoredTasksResponse = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${restoredUser.token}` },
    });

    expect(restoredTasksResponse.statusCode).toBe(200);
    const restoredTasks = restoredTasksResponse.json<Task[]>();
    expect(restoredTasks.some((item) => item.id === task.id)).toBe(true);
    expect(restoredTasks.find((item) => item.id === task.id)).toMatchObject({
      agentId: restoredUser.agent?.id,
      sessionKey: expect.stringContaining(task.id),
    });
  });

  it('shows the OpenClaw main direct session in the task list', async () => {
    const main = await login(app, 'main');
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${main.token}` },
      payload: {
        agentId: main.agent?.id,
        title: 'Prime main session',
        userInput: 'Prime main session',
      },
    });
    const gatewayAgentId = main.agent?.gatewayAgentId ?? 'main';
    await gateway.client.request('sessions.create', {
      key: 'main',
      agentId: gatewayAgentId,
      label: 'Main direct session',
    });

    const tasksResponse = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${main.token}` },
    });

    expect(tasksResponse.statusCode).toBe(200);
    expect(tasksResponse.json<Task[]>()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: main.agent?.id,
          sessionKey: `agent:${gatewayAgentId}:main`,
        }),
      ]),
    );
  });

  it('opens an Agent main task and creates child OpenClaw conversations', async () => {
    const userA = await login(app, 'alice');
    const agentId = userA.agent?.id;
    expect(agentId).toBeTruthy();

    const mainResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/main-task`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(mainResponse.statusCode).toBe(200);
    const mainTask = mainResponse.json<Task>();
    expect(mainTask).toMatchObject({
      userId: userA.user.id,
      agentId,
      status: 'completed',
    });
    expect(mainTask.sessionKey).toMatch(/^agent:gateway-agent-\d+:main$/);

    const conversationResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: 'Follow-up OpenClaw session' },
    });

    expect(conversationResponse.statusCode).toBe(200);
    const childTask = conversationResponse.json<Task>();
    expect(childTask).toMatchObject({
      userId: userA.user.id,
      agentId,
      title: 'Follow-up OpenClaw session',
      status: 'completed',
    });
    expect(childTask.sessionKey).toContain(`task:${childTask.id}`);

    const sessionCreateCalls = gateway.calls.filter((call) => call.method === 'sessions.create');
    expect(sessionCreateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ params: expect.objectContaining({ key: 'main' }) }),
        expect.objectContaining({
          params: expect.objectContaining({
            key: `task:${childTask.id}`,
            parentSessionKey: mainTask.sessionKey,
          }),
        }),
      ]),
    );
  });

  it('restores OpenClaw disk messages with trajectory steps for child sessions', async () => {
    const userA = await login(app, 'alice');
    const agentId = userA.agent?.id;
    expect(agentId).toBeTruthy();

    const mainResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/main-task`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const mainTask = mainResponse.json<Task>();
    const gatewayAgentId = mainTask.sessionKey?.split(':')[1];
    expect(gatewayAgentId).toBeTruthy();

    const conversationResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: 'Disk-backed history' },
    });
    const childTask = conversationResponse.json<Task>();
    const sessionId = 'history-session-1';
    const sessionsDir = join(workspaceRoot, 'agents', gatewayAgentId!, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        [childTask.sessionKey!]: {
          key: childTask.sessionKey,
          sessionId,
          title: childTask.title,
          status: 'completed',
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(sessionsDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({ type: 'session.started', timestamp: '2026-01-01T00:00:00.000Z' }),
        JSON.stringify({
          type: 'message',
          id: 'u1',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Build a report' }] },
        }),
        JSON.stringify({
          type: 'message',
          id: 'a1',
          timestamp: '2026-01-01T00:00:02.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'internal thinking must stay hidden' },
              { type: 'text', text: '<tool_call>{"name":"exec","arguments":{"cmd":"secret"}}</tool_call>' },
              { type: 'text', text: 'Report is ready.' },
            ],
          },
        }),
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(sessionsDir, `${sessionId}.trajectory.jsonl`),
      [
        JSON.stringify({ type: 'context.compiled', data: { tokenCount: 123 } }),
        JSON.stringify({ type: 'tool_call', data: { toolName: 'exec', command: 'python report.py', toolCallId: 'call-1' } }),
        JSON.stringify({ type: 'tool_result', data: { toolName: 'write', path: 'outputs/report.md', toolCallId: 'call-2' } }),
      ].join('\n'),
      'utf8',
    );

    const messagesResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${childTask.id}/messages`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(messagesResponse.statusCode).toBe(200);
    const messages = messagesResponse.json<Message[]>();
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages.at(-1)?.content).toBe('Report is ready.');
    expect(messages.at(-1)?.content).not.toContain('internal thinking');
    expect(messages.at(-1)?.content).not.toContain('tool_call');
    expect(messages.at(-1)?.planSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('exec: python report.py'), status: 'done' }),
        expect.objectContaining({ text: expect.stringContaining('write outputs/report.md'), status: 'done' }),
      ]),
    );

    await sendUserMessage(app, userA.token, childTask.id, 'Continue the same session');

    await waitForCondition(async () => {
      const continuedResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${childTask.id}/messages`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      const continued = continuedResponse.json<Message[]>();
      expect(continued.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(continued[0]?.content).toBe('Build a report');
      expect(continued[1]?.content).toBe('Report is ready.');
      expect(continued[1]?.planSteps).toEqual(expect.any(Array));
      expect(continued[2]?.content).toBe('Continue the same session');
      expect(continued[3]?.content).toContain('Continue the same session');
    });
  });

  it('deduplicates mirrored OpenClaw disk and local messages', async () => {
    const userA = await login(app, 'alice');
    const agentId = userA.agent?.id;
    expect(agentId).toBeTruthy();

    const mainResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/main-task`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const mainTask = mainResponse.json<Task>();
    const gatewayAgentId = mainTask.sessionKey?.split(':')[1];
    expect(gatewayAgentId).toBeTruthy();

    const conversationResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: 'Mirror-backed history' },
    });
    const childTask = conversationResponse.json<Task>();

    await sendUserMessage(app, userA.token, childTask.id, 'Mirror tool');
    await waitForCondition(async () => {
      const taskResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${childTask.id}`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(taskResponse.json<Task>().status).toBe('completed');
    });

    const localResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${childTask.id}/messages`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const localMessages = localResponse.json<Message[]>();
    expect(localMessages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(localMessages[1]?.planSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('read: IDENTITY.md'), status: 'done' }),
      ]),
    );

    const sessionId = 'mirrored-session-1';
    const sessionsDir = join(workspaceRoot, 'agents', gatewayAgentId!, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        [childTask.sessionKey!]: {
          key: childTask.sessionKey,
          sessionId,
          title: childTask.title,
          status: 'completed',
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(sessionsDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'message',
          id: 'disk-user',
          timestamp: new Date(Date.parse(localMessages[0]!.createdAt) + 1_000).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text: localMessages[0]!.content }] },
        }),
        JSON.stringify({
          type: 'message',
          id: 'disk-assistant',
          timestamp: new Date(Date.parse(localMessages[1]!.createdAt) + 1_000).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: localMessages[1]!.content }] },
        }),
      ].join('\n'),
      'utf8',
    );

    const mergedResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${childTask.id}/messages`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const merged = mergedResponse.json<Message[]>();

    expect(merged.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(merged.map((message) => message.content)).toEqual(localMessages.map((message) => message.content));
    expect(merged[1]?.parentMessageId).toBe(merged[0]?.id);
    expect(merged[1]?.planSteps).toEqual(localMessages[1]?.planSteps);
  });

  it('keeps live user prompts above parentless disk final answers after refresh', async () => {
    const userA = await login(app, 'alice');
    const agentId = userA.agent?.id;
    expect(agentId).toBeTruthy();

    const mainResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/main-task`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const mainTask = mainResponse.json<Task>();
    const gatewayAgentId = mainTask.sessionKey?.split(':')[1];
    expect(gatewayAgentId).toBeTruthy();

    const conversationResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: 'Parentless final refresh' },
    });
    const childTask = conversationResponse.json<Task>();

    await sendUserMessage(app, userA.token, childTask.id, 'Mirror tool');
    await waitForCondition(async () => {
      const taskResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${childTask.id}`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(taskResponse.json<Task>().status).toBe('completed');
    });

    const liveResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${childTask.id}/messages`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const liveMessages = liveResponse.json<Message[]>();
    expect(liveMessages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(liveMessages[1]?.planSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('read: IDENTITY.md'), status: 'done' }),
      ]),
    );

    const sessionId = 'parentless-final-refresh-session-1';
    const sessionsDir = join(workspaceRoot, 'agents', gatewayAgentId!, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        [childTask.sessionKey!]: {
          key: childTask.sessionKey,
          sessionId,
          title: childTask.title,
          status: 'completed',
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(sessionsDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'message',
          id: 'disk-refresh-user',
          timestamp: new Date(Date.parse(liveMessages[0]!.createdAt) + 1_000).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text: liveMessages[0]!.content }] },
        }),
        JSON.stringify({
          type: 'message',
          id: 'disk-refresh-assistant',
          timestamp: new Date(Date.parse(liveMessages[1]!.createdAt) + 1_000).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: 'Disk final document is ready.' }] },
        }),
      ].join('\n'),
      'utf8',
    );

    const mergedResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${childTask.id}/messages`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const merged = mergedResponse.json<Message[]>();

    expect(merged.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(merged[0]?.content).toBe(liveMessages[0]?.content);
    expect(merged[1]?.content).toBe('Disk final document is ready.');
    expect(merged[1]?.parentMessageId).toBe(merged[0]?.id);
    expect(merged[1]?.planSteps).toEqual(liveMessages[1]?.planSteps);
  });

  it('restores structured OpenClaw tool calls from session jsonl messages', async () => {
    const userA = await login(app, 'alice');
    const agentId = userA.agent?.id;
    expect(agentId).toBeTruthy();

    const mainResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/main-task`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const mainTask = mainResponse.json<Task>();
    const gatewayAgentId = mainTask.sessionKey?.split(':')[1];
    expect(gatewayAgentId).toBeTruthy();

    const conversationResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: 'Structured tool history' },
    });
    const childTask = conversationResponse.json<Task>();
    const sessionId = 'structured-tool-session-1';
    const sessionsDir = join(workspaceRoot, 'agents', gatewayAgentId!, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        [childTask.sessionKey!]: {
          key: childTask.sessionKey,
          sessionId,
          title: childTask.title,
          status: 'completed',
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(sessionsDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'message',
          id: 'u-structured',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Read config' }] },
        }),
        JSON.stringify({
          type: 'message',
          id: 'a-tool',
          parentId: 'u-structured',
          timestamp: '2026-01-01T00:00:02.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will inspect the config.' },
              { type: 'toolCall', id: 'call-read-1', name: 'read', arguments: { path: '/tmp/IDENTITY.md' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'r-tool',
          parentId: 'a-tool',
          timestamp: '2026-01-01T00:00:03.000Z',
          message: {
            role: 'toolResult',
            toolCallId: 'call-read-1',
            toolName: 'read',
            content: [{ type: 'text', text: '# IDENTITY\nName: XuanZhi' }],
            isError: false,
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'a-final',
          parentId: 'r-tool',
          timestamp: '2026-01-01T00:00:04.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'The config says XuanZhi.' }] },
        }),
      ].join('\n'),
      'utf8',
    );

    const messagesResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${childTask.id}/messages`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const messages = messagesResponse.json<Message[]>();

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.content).toContain('I will inspect the config.');
    expect(messages[1]?.content).toContain('The config says XuanZhi.');
    expect(messages[1]?.toolCalls).toEqual([
      expect.objectContaining({
        id: 'call-read-1',
        name: 'read',
        status: 'done',
        result: expect.stringContaining('Name: XuanZhi'),
      }),
    ]);
    expect(messages[1]?.planSteps).toEqual([
      expect.objectContaining({ id: 'call-read-1', text: expect.stringContaining('read: IDENTITY.md') }),
    ]);
  });

  it('keeps the user prompt before its assistant reply when OpenClaw disk timestamps are skewed', async () => {
    const userA = await login(app, 'alice');
    const agentId = userA.agent?.id;
    expect(agentId).toBeTruthy();

    const conversationResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: 'Skewed timestamp history' },
    });
    const childTask = conversationResponse.json<Task>();
    const gatewayAgentId = childTask.sessionKey?.split(':')[1];
    expect(gatewayAgentId).toBeTruthy();

    const sessionId = 'skewed-timestamp-session-1';
    const sessionsDir = join(workspaceRoot, 'agents', gatewayAgentId!, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        [childTask.sessionKey!]: {
          key: childTask.sessionKey,
          sessionId,
          title: childTask.title,
          status: 'completed',
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(sessionsDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'message',
          id: 'skewed-user',
          timestamp: '2026-01-01T00:00:10.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Generate a PQC document' }] },
        }),
        JSON.stringify({
          type: 'message',
          id: 'skewed-assistant',
          parentId: 'skewed-user',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'I will generate the PQC document.' }] },
        }),
      ].join('\n'),
      'utf8',
    );

    const messagesResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${childTask.id}/messages`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const messages = messagesResponse.json<Message[]>();

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.content).toBe('Generate a PQC document');
    expect(messages[1]?.content).toBe('I will generate the PQC document.');
  });

  it('keeps assistant replies after their preceding disk user message without explicit parent ids', async () => {
    const userA = await login(app, 'alice');
    const agentId = userA.agent?.id;
    expect(agentId).toBeTruthy();

    const conversationResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: 'Parentless disk history' },
    });
    const childTask = conversationResponse.json<Task>();
    const gatewayAgentId = childTask.sessionKey?.split(':')[1];
    expect(gatewayAgentId).toBeTruthy();

    const sessionId = 'parentless-disk-session-1';
    const sessionsDir = join(workspaceRoot, 'agents', gatewayAgentId!, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        [childTask.sessionKey!]: {
          key: childTask.sessionKey,
          sessionId,
          title: childTask.title,
          status: 'completed',
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(sessionsDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'message',
          id: 'parentless-user',
          timestamp: '2026-01-01T00:00:10.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Create a database document' }] },
        }),
        JSON.stringify({
          type: 'message',
          id: 'parentless-assistant',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'The database document is ready.' }] },
        }),
      ].join('\n'),
      'utf8',
    );

    const messagesResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${childTask.id}/messages`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const messages = messagesResponse.json<Message[]>();

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.parentMessageId).toBe(messages[0]?.id);
  });

  it('merges live assistant messages with disk history by parent user message', async () => {
    const userA = await login(app, 'alice');
    const agentId = userA.agent?.id;
    expect(agentId).toBeTruthy();

    const conversationResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: 'Tool failure merge' },
    });
    const childTask = conversationResponse.json<Task>();

    await sendUserMessage(app, userA.token, childTask.id, 'Explain information tools');
    await waitForCondition(async () => {
      const messagesResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${childTask.id}/messages`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      const liveMessages = messagesResponse.json<Message[]>();
      expect(liveMessages.map((message) => message.role)).toEqual(['user', 'assistant']);
    });

    const liveMessagesResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${childTask.id}/messages`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const liveMessages = liveMessagesResponse.json<Message[]>();
    expect(liveMessages[1]?.parentMessageId).toBe(liveMessages[0]?.id);

    const gatewayAgentId = childTask.sessionKey?.split(':')[1];
    expect(gatewayAgentId).toBeTruthy();
    const sessionId = 'parent-merge-session-1';
    const sessionsDir = join(workspaceRoot, 'agents', gatewayAgentId!, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        [childTask.sessionKey!]: {
          key: childTask.sessionKey,
          sessionId,
          title: childTask.title,
          status: 'completed',
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(sessionsDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'message',
          id: 'disk-user-parent',
          timestamp: new Date(Date.parse(liveMessages[0]!.createdAt) + 1_000).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text: liveMessages[0]!.content }] },
        }),
        JSON.stringify({
          type: 'message',
          id: 'disk-assistant-parent',
          parentId: 'disk-user-parent',
          timestamp: new Date(Date.parse(liveMessages[1]!.createdAt) + 1_000).toISOString(),
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Disk answer with real tool state.' },
              { type: 'toolCall', id: 'call-search-failed', name: 'web_search', arguments: { query: 'AI tools' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'disk-tool-result-parent',
          parentId: 'disk-assistant-parent',
          timestamp: new Date(Date.parse(liveMessages[1]!.createdAt) + 2_000).toISOString(),
          message: {
            role: 'toolResult',
            toolCallId: 'call-search-failed',
            toolName: 'web_search',
            content: [{ type: 'text', text: '{"status":"error","error":"missing_api_key"}' }],
            isError: true,
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const mergedResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${childTask.id}/messages`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const mergedMessages = mergedResponse.json<Message[]>();

    expect(mergedMessages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(mergedMessages[1]?.content).toBe('Disk answer with real tool state.');
    expect(mergedMessages[1]?.toolCalls).toEqual([
      expect.objectContaining({
        id: 'call-search-failed',
        name: 'web_search',
        status: 'error',
        result: expect.stringContaining('missing_api_key'),
      }),
    ]);
    expect(mergedMessages[1]?.planSteps).toEqual([
      expect.objectContaining({ id: 'call-search-failed', status: 'error' }),
    ]);
  });

  it('keeps delayed realtime tool failures visible without waiting for disk refresh', async () => {
    const userA = await login(app, 'alice');
    const task = await createTask(app, userA.token, 'Realtime failed tool');

    await sendUserMessage(app, userA.token, task.id, task.userInput);

    await waitForCondition(async () => {
      const taskResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(taskResponse.json<Task>().status).toBe('completed');
    });

    const messagesResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/messages`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const messages = messagesResponse.json<Message[]>();

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.planSteps).toEqual([
      expect.objectContaining({
        id: 'tool-realtime-fail',
        text: expect.stringContaining('web_search'),
        status: 'error',
      }),
    ]);
  });

  it('backfills realtime assistant tool failures from OpenClaw disk history before refresh', async () => {
    const userA = await login(app, 'alice');
    const task = await createTask(app, userA.token, 'Disk failed tool');

    await sendUserMessage(app, userA.token, task.id, task.userInput);

    await waitForCondition(async () => {
      const messagesResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/messages`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      const messages = messagesResponse.json<Message[]>();
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(messages[1]?.content).toBe('Runtime disk answer.');
      expect(messages[1]?.toolCalls).toEqual([
        expect.objectContaining({
          id: 'tool-disk-fail',
          name: 'web_fetch',
          status: 'error',
          result: expect.stringContaining('blocked'),
        }),
      ]);
      expect(messages[1]?.planSteps).toEqual([
        expect.objectContaining({
          id: 'tool-disk-fail',
          text: expect.stringContaining('web_fetch'),
          status: 'error',
        }),
      ]);
    });
  });

  it('creates repeated default conversations with unique OpenClaw labels', async () => {
    const userA = await login(app, 'alice');
    const agentId = userA.agent?.id;
    expect(agentId).toBeTruthy();

    const createConversation = () => app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: '新对话' },
    });

    const firstResponse = await createConversation();
    const secondResponse = await createConversation();

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(firstResponse.json<Task>().title).toBe('新对话');
    expect(secondResponse.json<Task>().title).toBe('新对话');

    const childSessionCalls = gateway.calls.filter((call) => (
      call.method === 'sessions.create'
      && (call.params as { key?: string }).key?.startsWith('task:')
    ));
    const labels = childSessionCalls.map((call) => (call.params as { label?: string }).label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('sends the first user message through a newly created child conversation', async () => {
    const userA = await login(app, 'alice');
    const agentId = userA.agent?.id;
    expect(agentId).toBeTruthy();

    const conversationResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: '新对话' },
    });

    expect(conversationResponse.statusCode).toBe(200);
    const childTask = conversationResponse.json<Task>();

    const tasksResponse = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(tasksResponse.json<Task>().find((task) => task.id === childTask.id)?.title).toBe('新对话');

    await sendUserMessage(app, userA.token, childTask.id, '请测试这个新建会话');

    await waitForCondition(() => {
      const chatSendCall = gateway.calls.find((call) => call.method === 'chat.send');
      expect(chatSendCall?.params).toMatchObject({
        sessionKey: childTask.sessionKey,
        message: '请测试这个新建会话',
      });
    });

    await waitForCondition(async () => {
      const taskResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${childTask.id}`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(taskResponse.json<Task>()).toMatchObject({
        id: childTask.id,
        title: '请测试这个新建会话',
        status: 'completed',
      });
    });
  });

  it('accepts OpenClaw final chat events without a sessionKey field', async () => {
    const userA = await login(app, 'alice');
    const agentId = userA.agent?.id;
    expect(agentId).toBeTruthy();

    const conversationResponse = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: '新对话' },
    });
    const childTask = conversationResponse.json<Task>();

    await sendUserMessage(app, userA.token, childTask.id, '无 sessionKey 事件也应该完成');

    await waitForCondition(async () => {
      const taskResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${childTask.id}`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(taskResponse.json<Task>()).toMatchObject({
        id: childTask.id,
        status: 'completed',
      });
    });

    const messagesResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${childTask.id}/messages`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(messagesResponse.json<Message[]>().at(-1)?.content).toContain('无 sessionKey 事件也应该完成');
  });

  it('blocks cross-user access to Agent session management routes', async () => {
    const userA = await login(app, 'alice');
    const userB = await login(app, 'bob');

    const rejectedMainTask = await app.inject({
      method: 'POST',
      url: `/api/agents/${userA.agent?.id}/main-task`,
      headers: { authorization: `Bearer ${userB.token}` },
    });

    const rejectedConversation = await app.inject({
      method: 'POST',
      url: `/api/agents/${userA.agent?.id}/conversations`,
      headers: { authorization: `Bearer ${userB.token}` },
      payload: { title: 'Cross-user attempt' },
    });

    expect(rejectedMainTask.statusCode).toBe(404);
    expect(rejectedConversation.statusCode).toBe(404);
  });

  it('rejects cross-user stream access', async () => {
    const userA = await login(app, 'alice');
    const userB = await login(app, 'bob');
    const task = await createTask(app, userA.token, 'Private task');

    const rejectedStream = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/stream?token=${encodeURIComponent(userB.token)}`,
    });

    expect(rejectedStream.statusCode).toBe(404);
  });

  it('accepts plugin writes with service token and ignores spoofed userId in payloads', async () => {
    const userA = await login(app, 'alice');
    const task = await createTask(app, userA.token, 'Generate project plan');

    const eventResponse = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/events`,
      headers: {
        authorization: 'Bearer dev-token',
      },
      payload: {
        userId: 'user_b',
        type: 'plugin.event',
        title: 'Plugin event',
        status: 'success',
      },
    });

    expect(eventResponse.statusCode).toBe(201);
    expect(eventResponse.json<AgentEvent>()).toMatchObject({
      userId: userA.user.id,
      taskId: task.id,
      title: 'Plugin event',
    });
  });

  it('starts multiple tasks for an OpenClaw session using service auth', async () => {
    const userA = await login(app, 'main');
    const sessionKey = `agent:${userA.agent?.gatewayAgentId}:main`;

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/api/openclaw/tasks/start',
      headers: {
        authorization: 'Bearer dev-token',
      },
      payload: {
        sessionKey,
        title: 'Artifact needed',
        summary: 'Need an artifact',
        userId: 'spoofed-user',
      },
    });
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/api/openclaw/tasks/start',
      headers: {
        authorization: 'Bearer dev-token',
      },
      payload: {
        sessionKey,
        title: 'Another artifact needed',
      },
    });

    expect(firstResponse.statusCode).toBe(201);
    expect(secondResponse.statusCode).toBe(201);
    expect(firstResponse.json<Task>()).toMatchObject({
      userId: userA.user.id,
      agentId: userA.agent?.id,
      sessionKey,
      title: 'Artifact needed',
    });
    expect(firstResponse.json<Task>().userId).not.toBe('spoofed-user');
    expect(secondResponse.json<Task>()).toMatchObject({
      userId: userA.user.id,
      agentId: userA.agent?.id,
      sessionKey,
      title: 'Another artifact needed',
    });
    expect(secondResponse.json<Task>().id).not.toBe(firstResponse.json<Task>().id);
  });

  it('rejects starting a task for an unknown OpenClaw agent session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/openclaw/tasks/start',
      headers: {
        authorization: 'Bearer dev-token',
      },
      payload: {
        sessionKey: 'agent:unknown-agent:main',
        title: 'Unknown agent task',
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('serves generated workspace files for the owning task and blocks unsafe access', async () => {
    const userA = await login(app, 'alice');
    const userB = await login(app, 'bob');
    const task = await createTask(app, userA.token, 'Generate files');
    const workspace = userA.agent?.workspace;

    expect(workspace).toBeTruthy();
    mkdirSync(join(workspace!, 'outputs'), { recursive: true });
    writeFileSync(join(workspace!, 'outputs', 'report.md'), '# 报告\n\n内容', 'utf8');
    writeFileSync(join(workspace!, 'outputs', 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
    writeFileSync(join(workspace!, 'outputs', 'page.html'), '<script>alert(1)</script>', 'utf8');

    const download = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/files?path=${encodeURIComponent('outputs/report.md')}`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.body).toContain('# 报告');

    const preview = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/files?path=${encodeURIComponent('outputs/chart.svg')}&inline=1&token=${encodeURIComponent(userA.token)}`,
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('image/svg+xml');
    expect(preview.headers['content-disposition']).toContain('inline');
    expect(preview.headers['x-content-type-options']).toBe('nosniff');

    const htmlDownload = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/files?path=${encodeURIComponent('outputs/page.html')}&inline=1`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(htmlDownload.statusCode).toBe(200);
    expect(htmlDownload.headers['content-disposition']).toContain('attachment');

    const traversal = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/files?path=${encodeURIComponent('../report.md')}`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(traversal.statusCode).toBe(400);

    const crossUser = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/files?path=${encodeURIComponent('outputs/report.md')}`,
      headers: { authorization: `Bearer ${userB.token}` },
    });

    expect(crossUser.statusCode).toBe(404);
  });

  it('lists task file assets on a separate route without changing generated file downloads', async () => {
    const userA = await login(app, 'alice');
    const task = await createTask(app, userA.token, 'Collect generated files');
    const workspace = userA.agent?.workspace;

    expect(workspace).toBeTruthy();
    mkdirSync(join(workspace!, 'outputs'), { recursive: true });
    writeFileSync(join(workspace!, 'outputs', 'report.md'), '# Report', 'utf8');

    const uploadResponse = await app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        name: 'notes.md',
        title: 'Research notes',
        content: '# Notes\n\nImportant context',
        mimeType: 'text/markdown',
        category: 'documents',
        taskId: task.id,
      },
    });

    expect(uploadResponse.statusCode).toBe(201);

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/file-assets`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<Array<{ name: string; workspacePath: string }>>()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expect.stringMatching(/notes.*\.md$/),
          workspacePath: expect.stringMatching(/notes.*\.md$/),
        }),
      ]),
    );

    const downloadResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/files?path=${encodeURIComponent('outputs/report.md')}`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(downloadResponse.statusCode).toBe(200);
    expect(downloadResponse.body).toContain('# Report');
  });

  it('only serves PDF file assets inline', async () => {
    const userA = await login(app, 'alice');
    const htmlUpload = await app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        name: 'page.html',
        content: '<script>alert(1)</script>',
        mimeType: 'text/html',
      },
    });
    const pdfUpload = await app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        name: 'report.pdf',
        content: '%PDF-1.7',
        mimeType: 'application/pdf',
      },
    });
    const html = htmlUpload.json<FileAsset>();
    const pdf = pdfUpload.json<FileAsset>();

    const [htmlDownload, pdfDownload] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/api/files/${html.id}/download?inline=1`,
        headers: { authorization: `Bearer ${userA.token}` },
      }),
      app.inject({
        method: 'GET',
        url: `/api/files/${pdf.id}/download?inline=1`,
        headers: { authorization: `Bearer ${userA.token}` },
      }),
    ]);

    expect(htmlDownload.headers['content-disposition']).toContain('attachment');
    expect(pdfDownload.headers['content-disposition']).toContain('inline');
  });

  it('does not import mentioned files outside the agent workspace', async () => {
    const userA = await login(app, 'alice');
    const task = await createTask(app, userA.token, 'Mention an unsafe file');
    writeFileSync(join(workspaceRoot, 'outside-secret.txt'), 'outside secret', 'utf8');

    await sendUserMessage(app, userA.token, task.id, 'Mention foo/../../outside-secret.txt');

    await waitForCondition(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(response.json<Task>().status).toBe('completed');
    });
    const filesResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/file-assets`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(filesResponse.json<FileAsset[]>()).toEqual([]);
  });

  it('does not import workspace symlinks that point outside the workspace', async () => {
    const userA = await login(app, 'alice');
    const task = await createTask(app, userA.token, 'Mention a linked file');
    const workspace = userA.agent!.workspace;
    const outsidePath = join(workspaceRoot, 'linked-secret.txt');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(outsidePath, 'linked outside secret', 'utf8');
    symlinkSync(outsidePath, join(workspace, 'outside-link.txt'));

    await sendUserMessage(app, userA.token, task.id, 'outside-link.txt');

    await waitForCondition(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(response.json<Task>().status).toBe('completed');
    });
    const filesResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/file-assets`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(filesResponse.json<FileAsset[]>()).toEqual([]);
  });

  it('imports only allowed generated files and skips OpenClaw profile files', async () => {
    const userA = await login(app, 'alice');
    const task = await createTask(app, userA.token, 'Create filtered workspace files');

    await sendUserMessage(app, userA.token, task.id, 'Create filtered workspace files');

    await waitForCondition(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/file-assets`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(response.json<FileAsset[]>()).toHaveLength(1);
    });
    const filesResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/file-assets`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const messagesResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/messages`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const assistantMessage = messagesResponse.json<Message[]>().find((message) => message.role === 'assistant');

    expect(filesResponse.json<FileAsset[]>()).toEqual([
      expect.objectContaining({
        title: 'report.pdf',
        source: 'workspace_imported',
        messageId: assistantMessage?.id,
      }),
    ]);
  });

  it('keeps generated files with the same basename from different paths', async () => {
    const userA = await login(app, 'alice');
    const task = await createTask(app, userA.token, 'Create duplicate reports');

    await sendUserMessage(app, userA.token, task.id, 'Create duplicate reports');

    await waitForCondition(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/file-assets`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(response.json<FileAsset[]>()).toHaveLength(2);
    });
    const filesResponse = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/file-assets`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(filesResponse.json<FileAsset[]>().map((file) => file.summary).sort()).toEqual([
      'OpenClaw workspace 文件: first/report.txt',
      'OpenClaw workspace 文件: second/report.txt',
    ]);
  });

  it('creates a new version when a generated workspace path changes', async () => {
    const userA = await login(app, 'alice');
    const task = await createTask(app, userA.token, 'Create report versions');

    await sendUserMessage(app, userA.token, task.id, 'Create report v1');
    let firstFile: FileAsset | undefined;
    await waitForCondition(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/file-assets`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      firstFile = response.json<FileAsset[]>()[0];
      expect(firstFile?.version).toBe(1);
    });

    await sendUserMessage(app, userA.token, task.id, 'Create report v2');

    await waitForCondition(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/files/${firstFile!.id}/versions`,
        headers: { authorization: `Bearer ${userA.token}` },
      });
      expect(response.json<FileAsset[]>().map((file) => file.version)).toEqual([2, 1]);
    });
  });

  it('serializes OpenClaw runs that share an agent workspace', async () => {
    const userA = await login(app, 'alice');
    const slowTask = await createTask(app, userA.token, 'Slow workspace run');
    const fastTask = await createTask(app, userA.token, 'Fast workspace run');

    await sendUserMessage(app, userA.token, slowTask.id, 'Slow workspace run');
    await sendUserMessage(app, userA.token, fastTask.id, 'Fast workspace run');

    await waitForCondition(() => {
      expect(gateway.calls.filter((call) => call.method === 'chat.send')).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.calls.filter((call) => call.method === 'chat.send')).toHaveLength(1);

    await waitForCondition(async () => {
      const [slowResponse, fastResponse] = await Promise.all([
        app.inject({
          method: 'GET',
          url: `/api/tasks/${slowTask.id}/file-assets`,
          headers: { authorization: `Bearer ${userA.token}` },
        }),
        app.inject({
          method: 'GET',
          url: `/api/tasks/${fastTask.id}/file-assets`,
          headers: { authorization: `Bearer ${userA.token}` },
        }),
      ]);
      expect(slowResponse.json<FileAsset[]>().map((file) => file.title)).toEqual(['slow.txt']);
      expect(fastResponse.json<FileAsset[]>().map((file) => file.title)).toEqual(['fast.txt']);
    });
  });

  it('stores context file ids and sends file context through the OpenClaw session', async () => {
    const userA = await login(app, 'alice');
    const task = await createTask(app, userA.token, 'Use a context file');

    const uploadResponse = await app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        name: 'brief.md',
        title: 'Brief',
        content: 'Use this brief as source material.',
        mimeType: 'text/markdown',
        taskId: task.id,
      },
    });
    expect(uploadResponse.statusCode).toBe(201);
    const file = uploadResponse.json<{ id: string }>();

    const message = await sendUserMessage(
      app,
      userA.token,
      task.id,
      'Summarize the attached file',
      [file.id],
    );

    expect(message.contextFileIds).toEqual([file.id]);

    await waitForCondition(() => {
      const chatSendCall = gateway.calls.find((call) => call.method === 'chat.send');
      expect(chatSendCall?.params).toMatchObject({
        sessionKey: expect.stringContaining(task.id),
      });
      expect((chatSendCall?.params as { message?: string }).message).toContain('Summarize the attached file');
      expect((chatSendCall?.params as { message?: string }).message).toContain('brief');
      expect((chatSendCall?.params as { message?: string }).message).toContain('Use this brief as source material.');
    });
  });
});
