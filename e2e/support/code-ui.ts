import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { dataDir, repoRoot, serverApi } from "./local-access";

interface PgResult {
  rows: Record<string, unknown>[];
}

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<PgResult>;
}

const requireFromServer = createRequire(
  path.join(repoRoot, "apps/server/package.json"),
);
const { Client } = requireFromServer("pg") as {
  Client: new (config: Record<string, unknown>) => PgClient;
};

export interface E2eProject {
  id: string;
  name: string;
  workDir: string;
}

export interface E2eSession {
  sessionId: string;
  projectId: string;
  workspacePath: string;
}

async function withDb<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
  const password = (
    await readFile(path.join(dataDir, "postgres-password"), "utf8")
  ).trim();
  const client = new Client({
    host: "127.0.0.1",
    port: 54330,
    user: "kenfutwork",
    database: "kenfutwork",
    password,
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function instanceId(): Promise<string> {
  const response = await serverApi("GET", "/api/instance");
  if (response.status !== 200) throw new Error("读取实例信息失败");
  const body = (await response.json()) as { instanceId: string };
  return body.instanceId;
}

export async function createCodeProject(name: string): Promise<E2eProject> {
  const response = await serverApi("POST", "/api/projects", {
    name,
    kind: "code",
  });
  if (response.status !== 201) {
    throw new Error(`创建项目失败: ${await response.text()}`);
  }
  const body = (await response.json()) as { project: E2eProject };
  if (!body.project.workDir) throw new Error("新建 Code 项目缺少工作目录");
  return body.project;
}

export async function createCodeSession(
  project: E2eProject,
): Promise<E2eSession> {
  const workspaces = await serverApi("GET", "/api/code-ui/workspaces");
  if (workspaces.status !== 200) throw new Error("读取工作目录失败");
  const entry = (
    (await workspaces.json()) as {
      workspaces: { projectId: string; path: string }[];
    }
  ).workspaces.find((item) => item.projectId === project.id);
  if (!entry) throw new Error("新建项目没有对应工作目录");
  const response = await serverApi("POST", "/api/code-ui/rpc", {
    service: "zcodeAgentService",
    method: "sendConversationCommandV4",
    args: [
      {
        workspacePath: entry.path,
        projectId: project.id,
        envelope: {
          commandId: randomUUID(),
          clientId: randomUUID(),
          sessionId: null,
          type: "createSession",
          payload: { workspaceId: project.id },
          issuedAt: Date.now(),
        },
      },
    ],
  });
  if (response.status !== 200) {
    throw new Error(`创建会话失败: ${await response.text()}`);
  }
  const ack = (
    (await response.json()) as {
      result: { result?: { sessionId?: string } };
    }
  ).result;
  const sessionId = ack.result?.sessionId;
  if (!sessionId) throw new Error("创建会话缺少任务身份");
  return { sessionId, projectId: project.id, workspacePath: entry.path };
}

/**
 * 在真实会话状态里追加一条工具行。状态来自服务端创建会话时的真实快照，
 * 这里只补一条工具行作为「已有事件的构造方式」，不替换宿主渲染与取数逻辑。
 */
export async function appendToolRow(
  sessionId: string,
  row: Record<string, unknown>,
): Promise<void> {
  await withDb(async (client) => {
    const state = await readSessionState(client, sessionId);
    const snapshot = (
      state.snapshots as {
        sessionId: string;
        control: Record<string, unknown>;
        rows: {
          window: { rowId?: number }[];
          totalCount: number;
          firstRowId: number | null;
        };
      }[]
    ).find((entry) => entry.sessionId === sessionId);
    if (!snapshot) throw new Error("会话状态缺少根快照");
    snapshot.rows.window = [...snapshot.rows.window, row];
    snapshot.rows.totalCount = snapshot.rows.window.length;
    snapshot.rows.firstRowId ??= snapshot.rows.window[0]?.rowId ?? null;
    // 新建会话处于草稿态，界面会停在欢迎页；已有行按完成态展示。
    snapshot.control.phase = "completedSuccess";
    snapshot.control.sessionEnded = true;
    snapshot.control.canStop = false;
    snapshot.control.stopState = "idle";
    await writeSessionState(client, sessionId, state);
  });
}

async function readSessionState(
  client: PgClient,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const result = await client.query(
    "select state from code_ui_sessions where id = $1",
    [sessionId],
  );
  const state = result.rows[0]?.state;
  if (!state || typeof state !== "object") throw new Error("会话状态为空");
  return state as Record<string, unknown>;
}

async function writeSessionState(
  client: PgClient,
  sessionId: string,
  state: Record<string, unknown>,
): Promise<void> {
  await client.query(
    "update code_ui_sessions set state = $2::jsonb, revision = revision + 1, updated_at = now() where id = $1",
    [sessionId, JSON.stringify(state)],
  );
}

export interface SeedRunOptions {
  instanceId: string;
  taskId: string;
  projectId: string;
  runId: string;
  startedAt: string;
}

/** 播种一次真实 Run：聊天会话、run 记录、轮次边界与最小事件流。 */
export async function seedRun(options: SeedRunOptions): Promise<void> {
  const chatSessionId = randomUUID();
  const threadId = randomUUID();
  await withDb(async (client) => {
    await client.query(
      "insert into chat_sessions (id, instance_id, project_id, mode, thread_id) values ($1, $2, $3, 'code', $4)",
      [chatSessionId, options.instanceId, options.projectId, threadId],
    );
    await client.query(
      "insert into agent_runs (id, model, session_id, status, thread_id, completed_at) values ($1, null, $2, 'completed', $3, now())",
      [options.runId, chatSessionId, threadId],
    );
    await client.query(
      "update code_ui_sessions set chat_session_id = $2 where id = $1",
      [options.taskId, chatSessionId],
    );
    await client.query(
      `insert into agent_turn_boundaries
         (run_id, phase, instance_id, project_id, task_id, boundary, task_kind)
       values ($1, 'pre', $2, $3, $4, $5::jsonb, 'code')`,
      [
        options.runId,
        options.instanceId,
        options.projectId,
        options.taskId,
        JSON.stringify({
          phase: "pre",
          scopeGeneration: 0,
          branchGeneration: null,
        }),
      ],
    );
    const events = [
      {
        type: "run.started",
        runId: options.runId,
        sessionId: chatSessionId,
        conversationId: chatSessionId,
        timestamp: options.startedAt,
      },
      {
        type: "run.completed",
        stopReason: "completed",
        runId: options.runId,
        timestamp: options.startedAt,
      },
    ];
    for (const [index, payload] of events.entries()) {
      await client.query(
        `insert into code_ui_events
           (instance_id, root_session_id, seq, event_key, parameter_fingerprint, payload)
         values ($1, $2::uuid, $3, $4, $5, $6::jsonb)`,
        [
          options.instanceId,
          options.taskId,
          index + 1,
          `${options.runId}/${index + 1}`,
          `e2e-run-${options.runId}-${index + 1}`,
          JSON.stringify(payload),
        ],
      );
    }
  });
}

export interface SeedToolCompletionOptions {
  instanceId: string;
  taskId: string;
  runId: string;
  toolCallId: string;
  outputText: string;
  toolName?: string;
}

/** 播种工具完成事件，供「查看原文」按 runId/toolCallId 引用读取。 */
export async function seedToolCompletion(
  options: SeedToolCompletionOptions,
): Promise<void> {
  await withDb(async (client) => {
    await client.query(
      `insert into code_ui_events
         (instance_id, root_session_id, seq, event_key, parameter_fingerprint, payload)
       values ($1, $2::uuid, $3, $4, $5, $6::jsonb)`,
      [
        options.instanceId,
        options.taskId,
        1,
        `${options.runId}/1`,
        `e2e-tool-${options.runId}-${options.toolCallId}`,
        JSON.stringify({
          type: "tool.completed",
          runId: options.runId,
          toolCallId: options.toolCallId,
          toolName: options.toolName ?? "Bash",
          status: "success",
          outputText: options.outputText,
          timestamp: new Date().toISOString(),
        }),
      ],
    );
  });
}

export function toolCallRow(options: {
  rowId: number;
  toolCallId: string;
  turnId: string;
  outputText: string;
  truncated?: { totalBytes: number; ref: string };
  /** 工具名决定工具卡渲染分支；查看原文入口只在通用兜底卡里出现。 */
  toolName?: string;
}): Record<string, unknown> {
  const now = Date.now();
  return {
    rowId: options.rowId,
    turnId: options.turnId,
    createdAt: now,
    createdAtSeq: 1,
    kind: "toolCall",
    toolCallId: options.toolCallId,
    toolName: options.toolName ?? "E2eNote",
    title: "查看原文",
    status: "success",
    inputText: "printf '查看原文'",
    startedAt: now - 1_000,
    endedAt: now,
    output: {
      text: options.outputText,
      ...(options.truncated ? { truncated: options.truncated } : {}),
    },
  };
}

export function turnHeaderRow(options: {
  rowId: number;
  turnId: string;
}): Record<string, unknown> {
  const now = Date.now();
  return {
    rowId: options.rowId,
    turnId: options.turnId,
    createdAt: now,
    createdAtSeq: 0,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: now - 10_000,
    endedAt: now,
  };
}

export function userInputRow(options: {
  rowId: number;
  turnId: string;
  text: string;
}): Record<string, unknown> {
  return {
    rowId: options.rowId,
    turnId: options.turnId,
    createdAt: Date.now(),
    createdAtSeq: 0,
    kind: "userInput",
    origin: "realUser",
    text: options.text,
  };
}
