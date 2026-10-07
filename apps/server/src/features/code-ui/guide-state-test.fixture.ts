import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { modelSelectionSchema } from "@zcode/shared";
import { expect, vi } from "vitest";
import { decodeNativeContextReference } from "../../agent/native-context-reference.js";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import {
  GUIDE_MODE_D_TEXT,
  GUIDE_MODE_FILE,
  GUIDE_MODE_FILE_CONTENT,
  GUIDE_MODE_MODEL,
  GUIDE_MODE_SUCCESS_CALL,
  GUIDE_MODE_SUCCESS_CONTENT,
  GUIDE_MODE_WRITE_CALL,
  guideModeFixture,
} from "./guide-mode.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { createCodeUiRepository } from "./repository.js";

export type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
export type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
export type Model = Awaited<ReturnType<typeof guideModeFixture>>;
const INITIAL_TEXT = "保持yolo正文流，等待下一条指导。";

/** 只复用真实公开HTTP/PG/native与工具事实；无describe或测试注册副作用。 */
export async function snapshot(host: Host) {
  return protocol.conversationSnapshotSchema.parse(await host.snapshot());
}

export async function task(fixture: Fixture, host: Host) {
  const record = await createCodeUiRepository(
    fixture.database.persistence,
  ).find(fixture.actor.instanceId, host.sessionId);
  if (!record?.state) throw new Error("真实Task与canonical输入未持久化。");
  return { ...record, state: record.state };
}

export async function runIds(fixture: Fixture, host: Host) {
  const rows = await fixture.database.persistence
    .forInstance(fixture.actor.instanceId)
    .query<{ id: string }>(
      `select r.id from public.agent_runs r
       join public.code_ui_sessions t on t.chat_session_id=r.session_id
       where t.instance_id=:instance and t.id=$1 and t.parent_session_id is null
       order by r.id`,
      [host.sessionId],
    );
  return rows.map((row) => row.id);
}

export function assertPolicyPrompt(
  model: Model,
  index: number,
  mode: "yolo" | "plan",
  ceiling: "yolo" | "plan" = "yolo",
) {
  const request = model.requests[index]?.body;
  if (!request) throw new Error("缺少实际模型HTTP请求。");
  const system = request.messages
    .filter((message) => ["system", "developer"].includes(message.role))
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");
  expect(system).toContain(
    `Task 审批模式：${mode}；派发时权限上限：${ceiling}`,
  );
  const tools = request.tools?.map((tool) => tool.function.name) ?? [];
  if (mode === "yolo")
    expect(tools, "前置：实际A应曝光可写Write。").toContain("Write");
  else expect(tools, "plan模型边界不得继续曝光Write。").not.toContain("Write");
  expect(request.model).toBe(GUIDE_MODE_MODEL);
}

export async function waitForPartial(host: Host, model: Model, index: number) {
  return vi.waitFor(
    async () => {
      expect(model.requests).toHaveLength(index + 1);
      const active = await snapshot(host);
      expect(active.rows.window).toContainEqual(
        expect.objectContaining({
          kind: "assistantText",
          text: model.texts[index],
          state: "streaming",
        }),
      );
      const primary = active.control.activeWorks.filter(
        (work) => work.kind === "primaryTurn",
      );
      expect(primary).toHaveLength(1);
      const runId = primary[0]?.foregroundExecutionId;
      if (!runId) throw new Error("真实模型正文缺少活动Run。");
      expect(active.pendingInteractions).toEqual([]);
      return { active, runId };
    },
    { timeout: 30_000 },
  );
}

export function assertTaskUnchanged(
  current: Awaited<ReturnType<typeof task>>,
  original: Awaited<ReturnType<typeof task>>,
  fixture: Fixture,
  activeRunId: string | null,
) {
  expect(current).toMatchObject({
    id: original.id,
    instance_id: fixture.actor.instanceId,
    project_id: original.project_id,
    root_directory: original.root_directory,
    additional_directories: original.additional_directories,
    scope_generation: original.scope_generation,
    branch_generation: original.branch_generation,
    sandbox_mode: original.sandbox_mode,
    execution_state: "ready",
    active_run_id: activeRunId,
  });
}

export async function prepareYoloRun(
  fixture: Fixture,
  host: Host,
  model: Model,
  options: { planEnabled?: boolean } = {},
) {
  const planEnabled = options.planEnabled ?? false;
  const idle = await snapshot(host);
  const selected = modelSelectionSchema.parse(idle.config.modelSelection);
  expect(selected.modelId, "前置：使用原fixture的有效模型。").toBe(
    GUIDE_MODE_MODEL,
  );
  const changed = await host.command(
    "switchCollaborationMode",
    { mode: "yolo" },
    randomUUID(),
    {
      baseRevision: idle.revision,
      baseLogEpoch: idle.logEpoch,
    },
  );
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(changed.body.result).status).toBe(
    "accepted",
  );
  const yolo = await snapshot(host);
  // 必须验证原RPC实际生效，不能只把yolo写进payload或外部模型提示。
  expect(yolo.config).toMatchObject({ mode: "yolo", planEnabled: false });
  const initialCommandId = randomUUID();
  const started = await host.command(
    "sendText",
    {
      text: INITIAL_TEXT,
      modelSelection: selected,
      mode: "yolo",
      planEnabled,
    },
    initialCommandId,
  );
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(started.body.result).status).toBe(
    "accepted",
  );
  const first = await waitForPartial(host, model, 0);
  expect(first.active.config).toMatchObject({
    mode: "yolo",
    planEnabled,
  });
  assertPolicyPrompt(
    model,
    0,
    planEnabled ? "plan" : "yolo",
    planEnabled ? "plan" : "yolo",
  );
  const original = await task(fixture, host);
  expect(original.sandbox_mode, "前置：原yolo作用域必须允许新文件写入。").toBe(
    "danger-full-access",
  );
  expect(original.root_directory).toBe(host.workspacePath);
  expect(await runIds(fixture, host)).toEqual([first.runId]);
  await expect(
    readFile(join(host.workspacePath, GUIDE_MODE_FILE)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const initialInput = original.state.inputs?.find(
    (input) => input.intent.sourceCommandId === initialCommandId,
  );
  if (!initialInput) throw new Error("前置：A缺少真实canonical输入。");
  const frozenA = structuredClone(initialInput);
  return { first, original, selected, initialCommandId, frozenA };
}

export function assertActualWriteError(model: Model, guideText: string) {
  const third = model.requests[2]?.body;
  if (!third) throw new Error("真实Write管线没有回到C模型请求。");
  const call = third.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? [])
    .find((entry) => entry.id === GUIDE_MODE_WRITE_CALL);
  if (!call) throw new Error("C请求缺少B实际发起的原Write调用。");
  expect(call.function.name).toBe("Write");
  expect(JSON.parse(call.function.arguments)).toEqual({
    file_path: GUIDE_MODE_FILE,
    content: GUIDE_MODE_FILE_CONTENT,
  });
  const results = third.messages.filter(
    (message) =>
      message.role === "tool" && message.tool_call_id === GUIDE_MODE_WRITE_CALL,
  );
  expect(results).toHaveLength(1);
  expect(JSON.stringify(results[0]?.content)).toMatch(
    /plan|只读|拒绝|权限|permission|denied/i,
  );
  expect(third.messages).toContainEqual(
    expect.objectContaining({ role: "user", content: guideText }),
  );
  expect(JSON.stringify(third.messages).split(guideText)).toHaveLength(2);
}

export async function assertErrorToolFact(
  fixture: Fixture,
  host: Host,
  runId: string,
) {
  const value = await snapshot(host);
  const tools = value.rows.window.filter(
    (row) => row.kind === "toolCall" && row.toolName === "Write",
  );
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({
    status: "error",
    input: { file_path: GUIDE_MODE_FILE, content: GUIDE_MODE_FILE_CONTENT },
  });
  const facts = await createCodeUiRepository(
    fixture.database.persistence,
  ).readToolCompletions(fixture.actor.instanceId, host.sessionId, runId, {
    maxEvents: 10,
    maxBytes: 10000,
  });
  expect(facts).toContainEqual(
    expect.objectContaining({
      runId,
      toolName: "Write",
      toolCallId: GUIDE_MODE_WRITE_CALL,
      status: "error",
    }),
  );
}

export async function assertCycleSuccessFacts(
  fixture: Fixture,
  host: Host,
  model: Model,
  runId: string,
) {
  const fourth = model.requests[3]?.body;
  if (!fourth) throw new Error("真实恢复Write未回到D模型请求。");
  const call = fourth.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? [])
    .find((entry) => entry.id === GUIDE_MODE_SUCCESS_CALL);
  if (!call) throw new Error("D缺少C实际发出的新Write调用。");
  expect(call.function.name).toBe("Write");
  expect(JSON.parse(call.function.arguments)).toEqual({
    file_path: GUIDE_MODE_FILE,
    content: GUIDE_MODE_SUCCESS_CONTENT,
  });
  const success = fourth.messages.filter(
    (message) =>
      message.role === "tool" &&
      message.tool_call_id === GUIDE_MODE_SUCCESS_CALL,
  );
  expect(success).toHaveLength(1);
  expect(JSON.stringify(success[0]?.content)).toContain(GUIDE_MODE_FILE);
  expect(
    await readFile(join(host.workspacePath, GUIDE_MODE_FILE), "utf8"),
  ).toBe(GUIDE_MODE_SUCCESS_CONTENT);
  const value = await snapshot(host);
  const tools = value.rows.window.filter(
    (row) => row.kind === "toolCall" && row.toolName === "Write",
  );
  expect(tools).toHaveLength(2);
  expect(tools).toMatchObject([
    {
      status: "error",
      input: { file_path: GUIDE_MODE_FILE, content: GUIDE_MODE_FILE_CONTENT },
    },
    {
      status: "success",
      input: {
        file_path: GUIDE_MODE_FILE,
        content: GUIDE_MODE_SUCCESS_CONTENT,
      },
    },
  ]);
  const facts = await createCodeUiRepository(
    fixture.database.persistence,
  ).readToolCompletions(fixture.actor.instanceId, host.sessionId, runId, {
    maxEvents: 10,
    maxBytes: 10000,
  });
  const writes = facts.filter((event) => event.toolName === "Write");
  expect(writes).toHaveLength(2);
  expect(writes).toMatchObject([
    { runId, toolCallId: GUIDE_MODE_WRITE_CALL, status: "error" },
    { runId, toolCallId: GUIDE_MODE_SUCCESS_CALL, status: "success" },
  ]);
}

export async function withModeFixture(
  cycle: boolean,
  scenario: (fixture: Fixture, host: Host, model: Model) => Promise<void>,
  createModel: () => Promise<Model> = () => guideModeFixture({ cycle }),
) {
  const model = await createModel();
  let fixture: Fixture | undefined;
  let host: Host | undefined;
  try {
    fixture = await createCodeUiHttpFixture();
    host = await createCodeSessionFixture(model.baseUrl, {
      client: fixture.client,
    });
    await scenario(fixture, host, model);
  } finally {
    try {
      if (host && (await snapshot(host)).control.activeWorks.length)
        await host.command("stop", {});
    } finally {
      try {
        await model.close();
      } finally {
        try {
          await host?.dispose();
        } finally {
          await fixture?.close();
        }
      }
    }
  }
}

export async function waitForSseClosure(
  model: Model,
  expectedClosed: readonly boolean[],
) {
  await vi.waitFor(
    () =>
      expect(model.requests.map((request) => request.closed)).toEqual(
        expectedClosed,
      ),
    { timeout: 30_000 },
  );
}

export async function finishAndWaitForCompletion(
  host: Host,
  model: Model,
  index: number,
) {
  model.finish(index);
  const current = host;
  return vi.waitFor(
    async () => {
      const value = await snapshot(current);
      expect(value.control).toMatchObject({
        phase: "completedSuccess",
        canStop: false,
        activeWorks: [],
      });
      expect(value.pendingInteractions).toEqual([]);
      expect(value.queue.items).toEqual([]);
      return value;
    },
    { timeout: 30_000 },
  );
}

export async function readNativeBoundaryState(
  fixture: Fixture,
  host: Host,
  runId: string,
  phase: "pre" | "post",
) {
  const boundaries = await fixture.app.kernel
    .get("agentRunMetadata")
    .getOwnedTurnBoundaries(fixture.actor, { taskId: host.sessionId, runId });
  const boundary = boundaries[phase];
  if (
    !boundary ||
    boundary.context.status !== "captured" ||
    !boundary.context.reference
  )
    throw new Error(`真实Run缺少native ${phase}边界。`);
  const native = decodeNativeContextReference(boundary.context.reference);
  const persistence = await fixture.app.kernel
    .get("agentPersistence")
    .getPersistence();
  if (!persistence) throw new Error("折返native persistence未装配。");
  const checkpoint = await persistence.checkpointer.get({
    configurable: {
      thread_id: native.threadId,
      checkpoint_ns: native.namespace,
      checkpoint_id: native.checkpointId,
    },
  });
  if (!checkpoint) throw new Error("真实native边界checkpoint缺失。");
  return { boundary, state: checkpoint.channel_values };
}

export async function readNativePostMessages(
  fixture: Fixture,
  host: Host,
  runId: string,
) {
  const { state } = await readNativeBoundaryState(fixture, host, runId, "post");
  const messages = state.messages;
  if (!Array.isArray(messages)) throw new Error("折返native消息缺失。");
  return messages;
}

export async function assertCycleNativePost(
  fixture: Fixture,
  host: Host,
  runId: string,
  guideIds: readonly string[],
  guideTexts: readonly string[],
) {
  const messages = await readNativePostMessages(fixture, host, runId);
  for (const [index, id] of guideIds.entries())
    expect(
      messages
        .filter(HumanMessage.isInstance)
        .filter(
          (message) =>
            message.id === id && message.content === guideTexts[index],
        ),
    ).toHaveLength(1);
  const toolMessages = messages.filter(ToolMessage.isInstance);
  expect(
    toolMessages.filter(
      (message) => message.tool_call_id === GUIDE_MODE_WRITE_CALL,
    ),
  ).toEqual([expect.objectContaining({ status: "error" })]);
  expect(
    toolMessages.filter(
      (message) => message.tool_call_id === GUIDE_MODE_SUCCESS_CALL,
    ),
  ).toEqual([expect.objectContaining({ status: "success" })]);
  expect(messages.filter(AIMessage.isInstance)).toContainEqual(
    expect.objectContaining({ content: GUIDE_MODE_D_TEXT }),
  );
}
