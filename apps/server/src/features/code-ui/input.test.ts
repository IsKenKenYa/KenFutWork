import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  zcodeUiProtocol as protocol,
  providerInstanceResponseSchema,
  workspaceSettingsSchema,
} from "@kenfutwork/shared";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerCodeUiRoutes } from "../../http/code-ui.js";
import { createLocalFsBlobStore } from "../blob/providers/local-fs.js";
import type {
  CodeAttachmentRecord,
  CodeAttachmentRepository,
  CodeAttachmentSession,
  CodeAttachmentTransaction,
} from "./attachments/types.js";
import { createCodeUiConversation } from "./conversation.js";
import type { CodeUiRepository, CodeUiSessionRecord } from "./repository.js";
import { CodeUiService, type CodeUiServiceDeps } from "./service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  options: {
    hang?: boolean;
    backgroundReady?: boolean;
    compactOutcome?: "applied" | "unchanged" | "failed" | "canceled";
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "kfw-code-input-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const actor = {
    id: randomUUID(),
    email: "human@example.test",
    accessToken: "private-token",
    userMetadata: {},
  };
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const clientId = randomUUID();
  const provider = providerInstanceResponseSchema.parse({
    id: randomUUID(),
    scope: "workspace",
    name: "Input test",
    protocol: "openai-compatible",
    hasCredential: true,
    configRevision: 1,
    headerKeys: [],
    enabled: true,
    models: [
      {
        id: "test",
        name: "Test",
        capability: "chat",
        vision: true,
        inputModalities: ["text", "image", "pdf"],
        reasoningEfforts: ["low", "high"],
      },
    ],
    compat: {
      codeUi: {
        models: {
          test: {
            useRecommendedConfig: true,
            config: {
              optionSpecs: {
                reasoningLevel: { map: '{"reasoning_effort": reasoningLevel}' },
              },
            },
          },
        },
      },
    },
  });
  const selection = {
    providerId: provider.id,
    modelId: "test",
    options: { reasoningLevel: "low" },
  };
  const scope = {
    workspaceId,
    projectId,
    taskId,
    rootDirectory: directory,
    additionalDirectories: [],
    sandboxMode: "workspace-write" as const,
    generation: 1,
  };
  const conversation = createCodeUiConversation({
    sessionId: taskId,
    workspacePath: directory,
    config: {
      provider: "zcode",
      model: "test",
      thought: "",
      followupMode: "queue",
      modelSelection: selection,
    },
  });
  const root: CodeUiSessionRecord = {
    id: taskId,
    workspace_id: workspaceId,
    project_id: projectId,
    root_directory: directory,
    additional_directories: [],
    sandbox_mode: "workspace-write",
    scope_generation: 1,
    branch_generation: 1,
    execution_state: "ready",
    chat_session_id: taskId,
    root_session_id: taskId,
    parent_session_id: null,
    parent_tool_call_id: null,
    state: conversation.exportState(),
    revision: 0,
    active_run_id: null,
    archived: false,
    pinned: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };
  const commands = new Map<
    string,
    { fingerprint: string; ack: protocol.CommandAck }
  >();
  const repository = {
    recoverRuntimeInputs: async () => {},
    readHumanPreferences: async () => ({}),
    find: async (workspace: string, id: string) =>
      workspace === workspaceId && id === taskId ? structuredClone(root) : null,
    list: async () => [structuredClone(root)],
    listRoots: async () => [structuredClone(root)],
    listVersion: async () => Number(root.revision),
    async startRunIfCurrent(workspace, task, runId, expected, start) {
      if (workspace !== workspaceId || task !== taskId) return false;
      const input = root.state?.inputs?.find((entry) => entry.runId === runId);
      if (
        root.archived ||
        root.execution_state !== "ready" ||
        Number(root.scope_generation) !== expected.scopeGeneration ||
        Number(root.branch_generation) !== expected.branchGeneration ||
        root.active_run_id !== runId ||
        root.state?.runId !== runId ||
        root.state.closedRuns.includes(runId) ||
        (expected.inputRequired && !input) ||
        (input &&
          (input.status !== "active" ||
            input.scopeGeneration !== expected.scopeGeneration ||
            input.branchGeneration !== expected.branchGeneration))
      )
        return false;
      start(structuredClone(root));
      return true;
    },
    async applyCommand(_workspace, envelope, fingerprint, decide) {
      const key = JSON.stringify([envelope.clientId, envelope.commandId]);
      const previous = commands.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new Error("command_conflict");
        return { ...previous.ack, status: "duplicate" };
      }
      const decision = decide(structuredClone(root));
      root.state = decision.state;
      root.active_run_id = decision.activeRunId;
      root.revision = Number(root.revision) + 1;
      const ack = protocol.commandAckSchema.parse(decision.ack);
      for (const settlement of decision.settlements ?? []) {
        const source = commands.get(
          JSON.stringify([settlement.clientId, settlement.commandId]),
        );
        if (source) source.ack = settlement.ack;
      }
      commands.set(key, { fingerprint, ack });
      return ack;
    },
    async appendEvent(_workspace, _task, _event, apply) {
      const decision = apply(structuredClone(root));
      root.state = decision.state;
      root.active_run_id = decision.activeRunId;
      root.revision = Number(root.revision) + 1;
      for (const settlement of decision.settlements ?? []) {
        const source = commands.get(
          JSON.stringify([settlement.clientId, settlement.commandId]),
        );
        if (source) source.ack = settlement.ack;
      }
      return true;
    },
    async applyScopeCommand(_workspace, envelope, fingerprint, change, decide) {
      const key = JSON.stringify([envelope.clientId, envelope.commandId]);
      const previous = commands.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new Error("command_conflict");
        return { ...previous.ack, status: "duplicate" };
      }
      await change(structuredClone(root));
      const decision = decide(structuredClone(root));
      root.state = decision.state;
      root.revision = Number(root.revision) + 1;
      const ack = protocol.commandAckSchema.parse(decision.ack);
      commands.set(key, { fingerprint, ack });
      return ack;
    },
    async queryCommands(_workspace, client, query) {
      return {
        results: query.map((input) => {
          const value = commands.get(JSON.stringify([client, input.commandId]));
          return { key: input, result: value?.ack ?? ("unknown" as const) };
        }),
      };
    },
  } satisfies Partial<CodeUiRepository>;
  const records = new Map<string, CodeAttachmentRecord>();
  const attachmentRepository: CodeAttachmentRepository = {
    async transact<T>(
      _session: CodeAttachmentSession,
      key: string,
      operation: (transaction: CodeAttachmentTransaction) => Promise<T>,
    ) {
      return operation({
        record: records.get(key) ?? null,
        async assertWritable() {},
        async save(value) {
          records.set(key, structuredClone(value));
        },
      }) as Promise<T>;
    },
    async findCommitted(identity, ref) {
      return (
        [...records.values()].find(
          (
            value,
          ): value is Extract<CodeAttachmentRecord, { status: "committed" }> =>
            value.status === "committed" &&
            value.ref === ref &&
            value.taskId === identity.taskId &&
            value.sessionId === identity.sessionId,
        ) ?? null
      );
    },
    async interruptStaging() {},
    async abortConnection() {},
    async close() {},
    async releaseTask() {},
    async purgeTask() {},
  };
  const runs: Array<{ input: unknown; options: unknown }> = [];
  const finishes = new Map<string, () => void>();
  const waits = new Map<string, Promise<void>>();
  const canceled = new Set<string>();
  const completed = new Map<string, Promise<void>>();
  const complete = new Map<string, () => void>();
  const starters: Array<{ count: number; resolve: () => void }> = [];
  const createAcceptedRun = vi.fn(async () => {});
  const updateRun = vi.fn(async () => {});
  const service = new CodeUiService({
    repository,
    attachmentRepository,
    blob: createLocalFsBlobStore({
      rootDir: directory,
      publicBaseUrl: "http://localhost/blob",
      signingSecret: "private-input-test",
    }),
    viewer: { resolveWorkspace: async () => ({ id: workspaceId }) },
    projects: {
      listProjects: async () => [
        {
          id: projectId,
          kind: "code",
          name: "Test",
          workDir: directory,
          additionalDirectories: [],
        },
      ],
    },
    modelProviders: {
      listInstances: async () => [provider],
      listProviderPresets: () => [],
    },
    modelCatalog: { listCatalog: async () => [] },
    settings: {
      getWorkspaceSettings: async () =>
        workspaceSettingsSchema.parse({ defaultModel: "test" }),
    },
    threads: {
      resolveOwnedSessionThread: async () => ({ threadId: `thread:${taskId}` }),
    },
    executionScopes: { openTask: async () => ({ describe: () => scope }) },
    agentRunMetadata: {
      createAcceptedRun,
      updateRun,
    },
    agentRuns: {
      createRun: (input: unknown, runOptions: { runId: string }) => {
        runs.push({ input, options: runOptions });
        waits.set(
          runOptions.runId,
          new Promise<void>((resolve) =>
            finishes.set(runOptions.runId, resolve),
          ),
        );
        completed.set(
          runOptions.runId,
          new Promise<void>((resolve) =>
            complete.set(runOptions.runId, resolve),
          ),
        );
        for (const starter of starters)
          if (runs.length >= starter.count) starter.resolve();
        return { runId: runOptions.runId };
      },
      async *streamRun(runId: string) {
        if (options.hang) await waits.get(runId);
        const current = runs.find(
          (run) => (run.options as { runId: string }).runId === runId,
        )!;
        const compact =
          (current.options as { operation?: { kind: string } }).operation
            ?.kind === "compact";
        if (
          compact &&
          options.compactOutcome === "applied" &&
          !canceled.has(runId)
        )
          await (
            current.options as { eventSink: (event: unknown) => Promise<void> }
          ).eventSink({
            type: "run.compacted",
            origin: "manual",
            runId,
            keepMessages: 20,
            timestamp: new Date().toISOString(),
          });
        await (
          current.options as { eventSink: (event: unknown) => Promise<void> }
        ).eventSink({
          type:
            canceled.has(runId) ||
            (compact && options.compactOutcome === "canceled")
              ? "run.canceled"
              : compact && options.compactOutcome === "failed"
                ? "run.failed"
                : "run.completed",
          runId,
          ...(compact && options.compactOutcome === "failed"
            ? { error: { code: "run_failed", message: "摘要模型拒绝请求" } }
            : {}),
          ...(compact &&
          (options.compactOutcome === "applied" ||
            options.compactOutcome === "unchanged")
            ? {
                operationResult: {
                  kind: "compact",
                  origin: "manual",
                  status: options.compactOutcome,
                  ...(options.compactOutcome === "unchanged"
                    ? { reason: "insufficient_history" }
                    : {}),
                },
              }
            : {}),
          timestamp: new Date().toISOString(),
        });
        complete.get(runId)?.();
      },
      cancelRun() {},
      async cancelRunAndWait(runId: string) {
        canceled.add(runId);
        finishes.get(runId)?.();
        await completed.get(runId);
      },
    },
    taskWork: {
      initialize: async () => [],
      notifyReady: async () => {},
      list: async () =>
        options.backgroundReady
          ? [
              {
                id: "ready-work",
                branchGeneration: 1,
                status: "completed",
                consumed: false,
              },
            ]
          : [],
    },
    env: {},
  } as unknown as CodeUiServiceDeps);
  cleanups.push(() => service.closeConnections());
  const events: unknown[] = [];
  const connection = await service.openConnection(
    actor,
    async (event) => {
      events.push(event);
    },
    () => {},
  );
  const rpc = (method: string, value: unknown) =>
    service.transportRpc(actor, connection.hello.connectionId, method, [value]);
  await rpc("initializeConversationV4", {
    kind: "clientHello",
    protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
    clientId,
    clientKind: "web",
    appVersion: "test",
  });
  const send = (payload: unknown, commandId = randomUUID()) =>
    rpc("sendConversationCommandV4", {
      workspacePath: directory,
      envelope: {
        clientId,
        commandId,
        sessionId: taskId,
        type: "sendText",
        payload,
        issuedAt: Date.now(),
      },
    });
  const command = (
    type: protocol.CommandType,
    payload: unknown,
    baseRevision: number,
    commandId = randomUUID(),
  ) =>
    rpc("sendConversationCommandV4", {
      workspacePath: directory,
      envelope: {
        clientId,
        commandId,
        sessionId: taskId,
        type,
        payload,
        baseRevision,
        issuedAt: Date.now(),
      },
    });
  async function upload(
    bytes: Buffer,
    mime = "text/plain",
    fileName = "用户输入.txt",
  ) {
    const uploadId = randomUUID();
    await rpc("attachmentBeginV4", {
      sessionId: taskId,
      uploadId,
      fileName,
      mime,
      totalBytes: bytes.length,
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
    if (bytes.length)
      await rpc("attachmentChunkV4", {
        sessionId: taskId,
        uploadId,
        chunkIndex: 0,
        dataBase64: bytes.toString("base64"),
      });
    return (await rpc("attachmentCommitV4", { sessionId: taskId, uploadId }))!
      .result as protocol.V4AttachmentCommitResult;
  }
  const waitRuns = (count: number) =>
    runs.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => starters.push({ count, resolve }));
  const finishRun = (index: number) =>
    finishes.get((runs[index]!.options as { runId: string }).runId)!();
  return {
    service,
    actor,
    workspaceId,
    taskId,
    clientId,
    selection,
    send,
    upload,
    rpc,
    runs,
    waitRuns,
    finishRun,
    command,
    directory,
    connectionId: connection.hello.connectionId,
    events,
    root,
    createAcceptedRun,
    updateRun,
  };
}

it("纯附件输入由真实提交ref进入共同Harness并持久为原消息附件，同命令重放不会再运行", async () => {
  const host = await fixture();
  const bytes = Buffer.from("姓名,金额\n小明,12\n", "utf8");
  const uploaded = await host.upload(bytes, "text/csv", "数据.csv");
  const attachment = {
    ref: uploaded.ref,
    fileName: "数据.csv",
    mime: "text/csv",
    bytes: bytes.length,
  };
  const commandId = randomUUID();
  const payload = {
    text: "",
    attachments: [attachment],
    modelSelection: host.selection,
  };
  const accepted = await host.send(payload, commandId);
  expect(accepted!.result).toMatchObject({
    status: "accepted",
    result: { delivery: "startNow" },
  });
  await accepted!.publish?.();
  const snapshot = await host.service.getSnapshot(host.actor, host.taskId);
  expect(
    snapshot.rows.window.find((row) => row.kind === "userInput"),
  ).toMatchObject({
    text: "",
    clientId: host.clientId,
    attachments: [attachment],
  });
  expect(host.runs).toHaveLength(1);
  expect(host.runs[0]!.options).toMatchObject({ codeInputs: [{ attachment }] });
  expect(
    Buffer.from(
      (host.runs[0]!.options as { codeInputs: Array<{ bytes: Uint8Array }> })
        .codeInputs[0]!.bytes,
    ),
  ).toEqual(bytes);
  expect(JSON.stringify(snapshot)).not.toContain(bytes.toString("base64"));
  const duplicate = await host.send(payload, commandId);
  await duplicate!.publish?.();
  expect(duplicate!.result).toMatchObject({ status: "duplicate" });
  expect(host.runs).toHaveLength(1);
});

it("后台终态自动续跑传持久host命令身份与background来源，重复通知不新建Run", async () => {
  const host = await fixture({ backgroundReady: true });
  await host.service.getSnapshot(host.actor, host.taskId);
  expect(await host.service.resumeTaskWork(host.workspaceId, host.taskId)).toBe(
    true,
  );
  await host.waitRuns(1);
  await expect
    .poll(
      async () =>
        (await host.service.getSnapshot(host.actor, host.taskId)).control.phase,
    )
    .toBe("completedSuccess");
  const snapshot = await host.service.getSnapshot(host.actor, host.taskId);
  const header = snapshot.rows.window.find((row) => row.kind === "turnHeader");
  expect(header).toMatchObject({ origin: "backgroundResult" });
  expect(host.runs[0]!.options).toMatchObject({
    inputIdentity: {
      clientId: "host.task-work",
      sourceCommandId: header!.sourceCommandId,
    },
    inputOrigin: "backgroundResult",
  });
  expect(await host.service.resumeTaskWork(host.workspaceId, host.taskId)).toBe(
    true,
  );
  expect(host.runs).toHaveLength(1);
});

it("忙时sendText进入同一Task持久FIFO，冻结完整提交选项且不伪造已开始的用户行", async () => {
  const host = await fixture({ hang: true });
  const first = await host.send({
    text: "第一轮",
    modelSelection: host.selection,
  });
  const running = first!.publish!();
  await host.waitRuns(1);
  try {
    const queued = await host.send({
      text: "第二轮",
      modelSelection: host.selection,
      mode: "plan",
      planEnabled: true,
    });
    expect(queued!.result).toMatchObject({
      status: "accepted",
      result: { type: "inputAccepted", delivery: "queue" },
    });
    await queued!.publish?.();
    const snapshot = await host.service.getSnapshot(host.actor, host.taskId);
    expect(snapshot.queue.items).toMatchObject([
      {
        text: "第二轮",
        clientId: host.clientId,
        modelSelection: host.selection,
        mode: "plan",
        planEnabled: true,
        delivery: { admitted: "queue" },
        dispatch: { state: "queued" },
      },
    ]);
    expect(
      snapshot.rows.window
        .filter((row) => row.kind === "userInput")
        .map((row) => row.text),
    ).toEqual(["第一轮"]);
    expect(host.runs).toHaveLength(1);
  } finally {
    host.finishRun(0);
    await running;
    if (host.runs.length > 1) host.finishRun(1);
  }
});

it("前台真实收尾后FIFO原子消费一次，使用admission冻结的模型选项、附件和原输入身份", async () => {
  const host = await fixture({ hang: true });
  const first = await host.send({
    text: "第一轮",
    modelSelection: host.selection,
  });
  const running = first!.publish!();
  await host.waitRuns(1);
  const bytes = Buffer.from("排队的数据");
  const uploaded = await host.upload(bytes);
  const attachment = {
    ref: uploaded.ref,
    fileName: "用户输入.txt",
    mime: "text/plain",
    bytes: bytes.length,
  };
  const secondSelection = {
    ...host.selection,
    options: { reasoningLevel: "high" },
  };
  const queued = await host.send({
    text: "第二轮",
    attachments: [attachment],
    modelSelection: secondSelection,
  });
  const canonicalInput = (
    await host.service.getSnapshot(host.actor, host.taskId)
  ).queue.items.find((record) => record.text === "第二轮")!;
  await queued!.publish?.();
  host.finishRun(0);
  await running;
  try {
    await expect.poll(() => host.runs.length).toBe(2);
    const snapshot = await host.service.getSnapshot(host.actor, host.taskId);
    expect(snapshot.queue.items).toEqual([]);
    expect(
      snapshot.rows.window.filter((row) => row.kind === "userInput"),
    ).toMatchObject([
      { text: "第一轮" },
      { text: "第二轮", attachments: [attachment] },
    ]);
    expect(snapshot.config.modelSelection).toEqual(secondSelection);
    expect(host.runs[1]!.options).toMatchObject({
      inputIdentity: {
        clientId: canonicalInput.clientId,
        sourceCommandId: canonicalInput.sourceCommandId,
      },
      inputOrigin: "userInput",
      modelInvocation: { body: { reasoning_effort: "high" } },
      codeInputs: [{ attachment }],
    });
  } finally {
    if (host.runs.length > 1) host.finishRun(1);
  }
});

it("原compact命令忙时进入同一FIFO，消费为维护操作且不新增用户行", async () => {
  const host = await fixture({ hang: true });
  const first = await host.send({
    text: "保留这一轮",
    modelSelection: host.selection,
  });
  const running = first!.publish!();
  await host.waitRuns(1);
  try {
    const before = await host.service.getSnapshot(host.actor, host.taskId);
    const compact = await host.command("compact", {}, before.revision);
    expect(protocol.commandAckSchema.parse(compact?.result)).toMatchObject({
      status: "accepted",
      result: { type: "inputAccepted", delivery: "queue" },
    });
    await compact!.publish?.();
    const queued = await host.service.getSnapshot(host.actor, host.taskId);
    expect(queued.queue.items).toMatchObject([
      { kind: "compact", text: "", attachments: [] },
    ]);
    expect(
      queued.rows.window
        .filter((row) => row.kind === "userInput")
        .map((row) => row.text),
    ).toEqual(["保留这一轮"]);
    host.finishRun(0);
    await running;
    await host.waitRuns(2);
    expect(host.runs[1]!.options).toMatchObject({
      operation: { kind: "compact" },
      inputOrigin: "controlOperation",
    });
    const active = await host.service.getSnapshot(host.actor, host.taskId);
    expect(
      active.rows.window
        .filter((row) => row.kind === "userInput")
        .map((row) => row.text),
    ).toEqual(["保留这一轮"]);
    expect(
      active.rows.window.find(
        (row) => row.kind === "timelineMarker" && row.marker.type === "compact",
      ),
    ).toMatchObject({
      marker: { type: "compact", origin: "manual", status: "running" },
    });
  } finally {
    host.finishRun(0);
    await running;
    if (host.runs.length > 1) host.finishRun(1);
  }
});

it("手动压缩完成更新原运行标记，不另造自动压缩或用户行", async () => {
  const host = await fixture({ hang: true, compactOutcome: "applied" });
  const before = await host.service.getSnapshot(host.actor, host.taskId);
  const command = await host.command("compact", {}, before.revision);
  const running = command!.publish!();
  await host.waitRuns(1);
  const active = await host.service.getSnapshot(host.actor, host.taskId);
  const marker = active.rows.window.find(
    (row) => row.kind === "timelineMarker",
  );
  try {
    host.finishRun(0);
    await running;
    const completed = await host.service.getSnapshot(host.actor, host.taskId);
    expect(completed.rows.window).toMatchObject([
      {
        rowId: marker!.rowId,
        kind: "timelineMarker",
        marker: { type: "compact", origin: "manual", status: "success" },
      },
    ]);
    expect(completed.rows.window).toHaveLength(1);
    expect(completed.control.phase).toBe("completedSuccess");
  } finally {
    host.finishRun(0);
    await running;
  }
});

it("历史不足时手动压缩明确无变化，冷读仍为原noop标记", async () => {
  const host = await fixture({ compactOutcome: "unchanged" });
  const before = await host.service.getSnapshot(host.actor, host.taskId);
  const command = await host.command("compact", {}, before.revision);
  await command!.publish!();
  const completed = await host.service.getSnapshot(host.actor, host.taskId);
  expect(completed.rows.window).toMatchObject([
    {
      kind: "timelineMarker",
      marker: { type: "compact", origin: "manual", status: "noop" },
    },
  ]);
  expect(completed.rows.window).toHaveLength(1);
  expect(completed.control.phase).toBe("completedSuccess");
});

it("手动压缩失败结束原标记并保留摘要错误，不发用户消息已保存通知", async () => {
  const host = await fixture({ compactOutcome: "failed" });
  const before = await host.service.getSnapshot(host.actor, host.taskId);
  const command = await host.command("compact", {}, before.revision);
  await command!.publish!();
  const failed = await host.service.getSnapshot(host.actor, host.taskId);
  expect(failed.rows.window).toMatchObject([
    {
      kind: "timelineMarker",
      marker: { type: "compact", origin: "manual", status: "failed" },
    },
  ]);
  expect(failed.rows.window).toHaveLength(1);
  expect(failed.control).toMatchObject({
    phase: "error",
    canStop: false,
    lastError: { message: "摘要模型拒绝请求" },
  });
  expect(host.events).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({ reason: "user_message_saved" }),
      }),
    ]),
  );
});

it("Stop取消运行中的手动压缩，原标记停止且不出现成功或用户行", async () => {
  const host = await fixture({ hang: true, compactOutcome: "applied" });
  const before = await host.service.getSnapshot(host.actor, host.taskId);
  const compact = await host.command("compact", {}, before.revision);
  const running = compact!.publish!();
  await host.waitRuns(1);
  try {
    const active = await host.service.getSnapshot(host.actor, host.taskId);
    const runId = (host.runs[0]!.options as { runId: string }).runId;
    const stopped = await host.command(
      "stop",
      { expectedForegroundExecutionId: runId },
      active.revision,
    );
    expect(stopped!.result).toMatchObject({ status: "accepted" });
    await running;
    const canceled = await host.service.getSnapshot(host.actor, host.taskId);
    expect(canceled.rows.window).toMatchObject([
      {
        kind: "timelineMarker",
        marker: { type: "compact", origin: "manual", status: "cancelled" },
      },
    ]);
    expect(canceled.rows.window).toHaveLength(1);
    expect(canceled.control).toMatchObject({
      phase: "completedInterrupted",
      canStop: false,
    });
  } finally {
    host.finishRun(0);
    await running;
  }
});

it("原setFollowupMode按Task CAS持久偏好，不造Run或宣称已提供guide执行能力", async () => {
  const host = await fixture();
  const before = await host.service.getSnapshot(host.actor, host.taskId);
  const changed = await host.command(
    "setFollowupMode",
    { mode: "guide" },
    before.revision,
  );
  expect(changed?.result).toMatchObject({ status: "accepted" });
  const current = await host.service.getSnapshot(host.actor, host.taskId);
  expect(current.config.followupMode).toBe("guide");
  expect(current.rows.window).toEqual([]);
  expect(host.runs).toEqual([]);
  const stale = await host.command(
    "setFollowupMode",
    { mode: "queue" },
    before.revision,
  );
  expect(stale?.result).toMatchObject({
    status: "rejected",
    reasonCode: "proto.staleRevision",
  });
  expect(
    (await host.service.getSnapshot(host.actor, host.taskId)).config
      .followupMode,
  ).toBe("guide");
});

it("队列暂停/重排/删除由服务端CAS裁决；同删除命令重放不能删除其它项", async () => {
  const host = await fixture({ hang: true });
  const first = await host.send({
    text: "第一轮",
    modelSelection: host.selection,
  });
  const running = first!.publish!();
  await host.waitRuns(1);
  try {
    await host.send({ text: "第二轮", modelSelection: host.selection });
    await host.send({ text: "第三轮", modelSelection: host.selection });
    let snapshot = await host.service.getSnapshot(host.actor, host.taskId);
    const pause = await host.command(
      "setAutoDrain",
      { autoDrain: false },
      snapshot.revision,
    );
    expect(pause!.result).toMatchObject({ status: "accepted" });
    snapshot = await host.service.getSnapshot(host.actor, host.taskId);
    const firstItem = snapshot.queue.items[0]!.queueItemId;
    const secondItem = snapshot.queue.items[1]!.queueItemId;
    const reordered = await host.command(
      "reorderQueueItem",
      { queueItemId: secondItem, beforeQueueItemId: firstItem },
      snapshot.revision,
    );
    expect(reordered!.result).toMatchObject({ status: "accepted" });
    const stale = await host.command(
      "deleteQueueItem",
      { queueItemId: firstItem },
      snapshot.revision,
    );
    expect(stale!.result).toMatchObject({
      status: "rejected",
      reasonCode: "proto.staleRevision",
    });
    snapshot = await host.service.getSnapshot(host.actor, host.taskId);
    const commandId = randomUUID();
    const removed = await host.command(
      "deleteQueueItem",
      { queueItemId: firstItem },
      snapshot.revision,
      commandId,
    );
    expect(removed!.result).toMatchObject({ status: "accepted" });
    const replay = await host.command(
      "deleteQueueItem",
      { queueItemId: firstItem },
      snapshot.revision,
      commandId,
    );
    expect(replay!.result).toMatchObject({ status: "duplicate" });
    expect(
      (await host.service.getSnapshot(host.actor, host.taskId)).queue,
    ).toMatchObject({
      autoDrain: false,
      pauseReason: "manual",
      items: [{ queueItemId: secondItem, text: "第三轮" }],
    });
  } finally {
    host.finishRun(0);
    await running;
  }
  expect(host.runs).toHaveLength(1);
});

it("busy requested startNow先持久认领并等待旧Run真正停止，绝不先排队或双重抢占", async () => {
  const host = await fixture({ hang: true });
  const first = await host.send({
    text: "旧轮",
    modelSelection: host.selection,
  });
  const running = first!.publish!();
  await host.waitRuns(1);
  const forced = await host.send({
    text: "立即发送",
    modelSelection: host.selection,
    requestedDelivery: "startNow",
  });
  expect(forced!.result).toMatchObject({
    status: "accepted",
    result: { delivery: "startNow" },
  });
  expect(
    (await host.service.getSnapshot(host.actor, host.taskId)).queue.items,
  ).toEqual([]);
  const competing = await host.send({
    text: "另一端抢占",
    modelSelection: host.selection,
    requestedDelivery: "startNow",
  });
  expect(competing!.result).toMatchObject({
    status: "rejected",
    reasonCode: "guard.preemptionPending",
  });
  const replacing = forced!.publish!();
  await running;
  try {
    await expect.poll(() => host.runs.length).toBe(2);
    expect(
      (
        await host.service.getSnapshot(host.actor, host.taskId)
      ).rows.window.filter((row) => row.kind === "turnHeader"),
    ).toMatchObject([{ state: "completedInterrupted" }, { state: "running" }]);
    expect(
      (await host.service.getSnapshot(host.actor, host.taskId)).rows.window
        .filter((row) => row.kind === "userInput")
        .map((row) => row.text),
    ).toEqual(["旧轮", "立即发送"]);
  } finally {
    if (host.runs.length > 1) host.finishRun(1);
    await replacing;
  }
});

it("Stop在立即发送认领后先取消reserved输入，迟到publish不能启动新轮", async () => {
  const host = await fixture({ hang: true });
  const first = await host.send({
    text: "旧轮",
    modelSelection: host.selection,
  });
  const running = first!.publish!();
  await host.waitRuns(1);
  const commandId = randomUUID();
  const forced = await host.send(
    {
      text: "待抢占输入",
      modelSelection: host.selection,
      requestedDelivery: "startNow",
    },
    commandId,
  );
  const snapshot = await host.service.getSnapshot(host.actor, host.taskId);
  const stopped = await host.command(
    "stop",
    {
      expectedForegroundExecutionId: (
        host.runs[0]!.options as { runId: string }
      ).runId,
    },
    snapshot.revision,
  );
  expect(stopped!.result).toMatchObject({ status: "accepted" });
  await running;
  const late = forced!.publish!();
  try {
    // 若迟到输入错误启动，释放它以免失败测试留下悬挂流。
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(host.runs).toHaveLength(1);
    const current = await host.service.getSnapshot(host.actor, host.taskId);
    expect(
      current.rows.window
        .filter((row) => row.kind === "userInput")
        .map((row) => row.text),
    ).toEqual(["旧轮"]);
    expect(current.pendingCommands).toEqual([]);
    const receipt = await host.rpc("queryConversationCommandsV4", {
      commands: [{ sessionId: host.taskId, commandId }],
    });
    expect(receipt!.result).toMatchObject({
      results: [
        {
          result: {
            status: "failed",
            reasonCode: "fault.command.inputStopped",
            result: { type: "inputDisposition", delivery: "startNow" },
          },
        },
      ],
    });
  } finally {
    if (host.runs.length > 1) host.finishRun(1);
    await late;
  }
});

it("Stop在输入已保存但Harness尚未启动时关闭该轮，迟到publish不执行模型", async () => {
  const host = await fixture();
  const admitted = await host.send({
    text: "尚未派发",
    modelSelection: host.selection,
  });
  const current = await host.service.getSnapshot(host.actor, host.taskId);
  const execution = current.control.activeWorks.find(
    (work) => work.kind === "primaryTurn",
  )!.foregroundExecutionId;
  const stopped = await host.command(
    "stop",
    { expectedForegroundExecutionId: execution },
    current.revision,
  );
  expect(stopped!.result).toMatchObject({ status: "accepted" });
  await admitted!.publish!();
  expect(host.runs).toHaveLength(0);
  expect(
    (await host.service.getSnapshot(host.actor, host.taskId)).control.phase,
  ).toBe("completedInterrupted");
});

it("Stop在已接受元信息落库与同步Harness登记之间关闭输入，恢复publish不登记运行", async () => {
  const host = await fixture();
  let accepted!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  host.createAcceptedRun.mockImplementation(async () => {
    accepted();
    await released;
  });
  const prepared = await host.send({
    text: "登记窗口",
    modelSelection: host.selection,
  });
  if (!prepared?.publish) throw new Error("测试输入未被认领");
  const publishing = prepared.publish();
  await reached;
  const snapshot = await host.service.getSnapshot(host.actor, host.taskId);
  const stopped = await host.command("stop", {}, snapshot.revision);
  await stopped?.publish?.();
  resume();
  await publishing;
  expect(host.runs).toHaveLength(0);
  expect(host.updateRun).toHaveBeenCalledWith(
    expect.objectContaining({ status: "canceled" }),
  );
  expect(
    (await host.service.getSnapshot(host.actor, host.taskId)).control.phase,
  ).toBe("completedInterrupted");
});

it.each([
  [
    "scope改变",
    (root: CodeUiSessionRecord) => {
      root.scope_generation = Number(root.scope_generation) + 1;
    },
  ],
  [
    "branch改变",
    (root: CodeUiSessionRecord) => {
      root.branch_generation = Number(root.branch_generation) + 1;
    },
  ],
  [
    "关闭正在撤销",
    (root: CodeUiSessionRecord) => {
      root.execution_state = "revoking";
    },
  ],
  [
    "归档",
    (root: CodeUiSessionRecord) => {
      root.archived = true;
    },
  ],
  [
    "canonical输入丢弃",
    (root: CodeUiSessionRecord) => {
      const input = root.state?.inputs?.[0];
      if (!input) throw new Error("测试输入未被认领");
      input.status = "discarded";
    },
  ],
  [
    "canonical输入缺失",
    (root: CodeUiSessionRecord) => {
      if (!root.state) throw new Error("测试会话状态缺失");
      root.state.inputs = [];
    },
  ],
] as const)("输入已接受后%s时不能登记Harness", async (_label, change) => {
  const host = await fixture();
  host.createAcceptedRun.mockImplementation(async () => {
    change(host.root);
  });
  const prepared = await host.send({
    text: "代际窗口",
    modelSelection: host.selection,
  });
  if (!prepared?.publish) throw new Error("测试输入未被认领");
  await prepared.publish();
  expect(host.runs).toHaveLength(0);
  expect(host.updateRun).toHaveBeenCalledWith(
    expect.objectContaining({ status: "canceled" }),
  );
});

it("同一已认领输入的publish并发重复调用也只启动一次Harness", async () => {
  const host = await fixture();
  const admitted = await host.send({
    text: "发布一次",
    modelSelection: host.selection,
  });
  await Promise.all([admitted!.publish!(), admitted!.publish!()]);
  expect(host.runs).toHaveLength(1);
});

it("真实HTTP在已保存输入后丢失响应仍启动该轮，同命令重试不会再执行", async () => {
  const host = await fixture();
  const app = Fastify();
  cleanups.push(async () => {
    await app.close();
  });
  await registerCodeUiRoutes(app, {
    auth: { authenticate: async () => host.actor },
    service: host.service,
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.method === "POST" && request.url === "/api/code-ui/rpc")
      reply.raw.destroy();
    return payload;
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const commandId = randomUUID();
  const payload = { text: "响应丢失", modelSelection: host.selection };
  await expect(
    fetch(`${address}/api/code-ui/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "zcodeAgentService",
        method: "sendConversationCommandV4",
        connectionId: host.connectionId,
        args: [
          {
            workspacePath: host.directory,
            envelope: {
              commandId,
              clientId: host.clientId,
              sessionId: host.taskId,
              type: "sendText",
              payload,
              issuedAt: Date.now(),
            },
          },
        ],
      }),
    }),
  ).rejects.toThrow();
  await expect.poll(() => host.runs.length, { timeout: 500 }).toBe(1);
  const replay = await host.send(payload, commandId);
  await replay!.publish?.();
  expect(replay!.result).toMatchObject({ status: "duplicate" });
  expect(host.runs).toHaveLength(1);
});

it("暂停队列必须确认完整队列集合，过时clear拒绝；keep立即发送后仍保留暂停队列", async () => {
  const host = await fixture({ hang: true });
  const first = await host.send({
    text: "第一轮",
    modelSelection: host.selection,
  });
  const running = first!.publish!();
  await host.waitRuns(1);
  await host.send({ text: "保留项", modelSelection: host.selection });
  let snapshot = await host.service.getSnapshot(host.actor, host.taskId);
  const paused = await host.command(
    "setAutoDrain",
    { autoDrain: false },
    snapshot.revision,
  );
  await paused!.publish?.();
  host.finishRun(0);
  await running;
  snapshot = await host.service.getSnapshot(host.actor, host.taskId);
  expect(snapshot.inputRouting.mode).toBe("choice");
  const missing = await host.send({
    text: "新输入",
    modelSelection: host.selection,
  });
  expect(missing!.result).toMatchObject({
    status: "rejected",
    reasonCode: "guard.heldQueueChoiceRequired",
  });
  const stale = await host.send({
    text: "新输入",
    modelSelection: host.selection,
    heldQueueDisposition: "clearQueueAndSend",
    expectedHeldQueueItemIds: [],
  });
  expect(stale!.result).toMatchObject({
    status: "rejected",
    reasonCode: "proto.staleRevision",
  });
  const kept = await host.send({
    text: "立即开始",
    modelSelection: host.selection,
    heldQueueDisposition: "keepQueueAndSend",
    expectedHeldQueueItemIds: snapshot.queue.items.map(
      (item) => item.queueItemId,
    ),
  });
  expect(kept!.result).toMatchObject({
    status: "accepted",
    result: { delivery: "startNow" },
  });
  const replacing = kept!.publish!();
  await host.waitRuns(2);
  host.finishRun(1);
  await replacing;
  snapshot = await host.service.getSnapshot(host.actor, host.taskId);
  expect(snapshot.queue).toMatchObject({
    autoDrain: false,
    items: [{ text: "保留项" }],
  });
  expect(snapshot.inputRouting.mode).toBe("choice");
  expect(host.runs).toHaveLength(2);
});

it("同workspace其它用户不能借用已知SSE connectionId握手或读取连接身份", async () => {
  const host = await fixture();
  const foreign = { ...host.actor, id: randomUUID() };
  await expect(
    host.service.transportRpc(
      foreign,
      host.connectionId,
      "helloConversationV4",
      [],
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    host.service.transportRpc(
      foreign,
      host.connectionId,
      "initializeConversationV4",
      [
        {
          kind: "clientHello",
          clientId: host.clientId,
          protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
          clientKind: "web",
          appVersion: "test",
        },
      ],
    ),
  ).rejects.toMatchObject({ code: "not_found" });
});

it("原sendQueuedNow按CAS认领指定项并停止旧轮，保留原输入身份和其余FIFO", async () => {
  const host = await fixture({ hang: true });
  const first = await host.send({
    text: "正在运行",
    modelSelection: host.selection,
  });
  const running = first!.publish!();
  await host.waitRuns(1);
  await host.send({ text: "FIFO第一项", modelSelection: host.selection });
  await host.send({ text: "指定立即项", modelSelection: host.selection });
  let snapshot = await host.service.getSnapshot(host.actor, host.taskId);
  const selected = snapshot.queue.items[1]!;
  const paused = await host.command(
    "setAutoDrain",
    { autoDrain: false },
    snapshot.revision,
  );
  await paused!.publish?.();
  snapshot = await host.service.getSnapshot(host.actor, host.taskId);
  const promoted = await host.command(
    "sendQueuedNow",
    { queueItemId: selected.queueItemId },
    snapshot.revision,
  );
  expect(promoted!.result).toMatchObject({ status: "accepted" });
  const replacing = promoted!.publish!();
  await running;
  try {
    await expect.poll(() => host.runs.length).toBe(2);
    snapshot = await host.service.getSnapshot(host.actor, host.taskId);
    expect(snapshot.queue.items).toMatchObject([{ text: "FIFO第一项" }]);
    expect(
      snapshot.rows.window
        .filter((row) => row.kind === "userInput")
        .map((row) => ({
          text: row.text,
          sourceCommandId: row.sourceCommandId,
        })),
    ).toEqual([
      {
        text: "正在运行",
        sourceCommandId: (first!.result as protocol.CommandAck).commandId,
      },
      { text: "指定立即项", sourceCommandId: selected.sourceCommandId },
    ]);
  } finally {
    if (host.runs.length > 1) host.finishRun(1);
    await replacing;
  }
});
