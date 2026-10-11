import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodeUiEvent,
  instanceSettingsSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { zcodeTaskMetaSchema } from "@zcode/shared";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentRunService } from "../../agent/runtime.js";
import { loadServerEnv } from "../../config/env.js";
import { createCodeUiConversation } from "./conversation.js";
import { createCodeUiTestInstance } from "./host-session.fixture.js";
import type { CodeUiRepository, CodeUiSessionRecord } from "./repository.js";
import { CodeUiService, type CodeUiServiceDeps } from "./service.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(
  options: { searchResults?: number; enumerationUnavailable?: boolean } = {},
) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-project-identity-")),
  );
  temporary.push(base);
  const pathA = join(base, "A");
  const pathB = join(base, "B");
  const reference = join(base, "reference");
  await Promise.all([mkdir(pathA), mkdir(pathB), mkdir(reference)]);
  const instanceId = randomUUID();
  const actor = { instanceId, accessClientId: null };
  const firstId = randomUUID();
  const secondId = randomUUID();
  const taskId = randomUUID();
  const projects = [
    {
      id: firstId,
      kind: "code",
      name: "first",
      workDir: pathA,
      additionalDirectories: [],
    },
    {
      id: secondId,
      kind: "code",
      name: "second",
      workDir: pathA,
      additionalDirectories: [],
    },
  ];
  const host = createCodeUiConversation({
    sessionId: taskId,
    workspacePath: pathA,
    config: {
      provider: "zcode",
      model: "test",
      thought: "",
      followupMode: "queue",
    },
  });
  host.startTurn({
    runId: randomUUID(),
    commandId: randomUUID(),
    text: "old Task",
  });
  const root: CodeUiSessionRecord = {
    id: taskId,
    instance_id: instanceId,
    project_id: secondId,
    root_directory: pathA,
    additional_directories: [],
    sandbox_mode: "workspace-write",
    scope_generation: 0,
    branch_generation: 1,
    execution_state: "ready",
    chat_session_id: null,
    root_session_id: taskId,
    parent_session_id: null,
    parent_tool_call_id: null,
    state: host.exportState(),
    revision: 1,
    active_run_id: null,
    archived: false,
    pinned: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };
  const roots = [root];
  const createRoot = vi.fn(
    async (
      _workspace: string,
      input: Parameters<CodeUiRepository["createRoot"]>[1],
    ) => {
      roots.push({
        ...root,
        id: input.sessionId,
        root_session_id: input.sessionId,
        project_id: input.projectId,
        root_directory: input.scope.rootDirectory,
        additional_directories: input.scope.additionalDirectories,
        scope_generation: input.scope.generation,
        sandbox_mode: input.scope.sandboxMode,
        state: input.state,
      });
      return {
        commandId: input.command.commandId,
        status: "accepted",
        revisionAtDecision: 0,
        result: { type: "createSession", sessionId: input.sessionId },
      };
    },
  );
  const repository = {
    preparations: { recover: async () => {} },
    recoverRuntimeInputs: async () => {},
    readHumanPreferences: async () => ({}),
    listRoots: async () => {
      if (options.enumerationUnavailable)
        throw new Error("工作区全量列表暂不可用");
      return roots;
    },
    find: async (_workspace: string, id: string) =>
      roots.find((entry) => entry.id === id) ?? null,
    list: async (_workspace: string, id: string) =>
      roots.filter((entry) => entry.project_id === id),
    listVersion: async () => 1,
    beginCloseTask: async () => 1,
    failCloseTask: async () => {},
    setListState: async (
      _workspace: string,
      id: string,
      value: { archived?: boolean },
    ) => {
      const record = roots.find((entry) => entry.id === id);
      if (record && value.archived !== undefined)
        record.archived = value.archived;
    },
    createRoot,
  };
  const env = loadServerEnv(
    { agentBackendMode: "filesystem", agentFilesRoot: pathA },
    {},
  );
  const service = new CodeUiService({
    agentRuns: createAgentRunService({
      env,
      blob: {} as never,
      localInstance: createCodeUiTestInstance(instanceId).localInstance,
    }),
    repository,
    beforeCloseTask: async () => {},
    localInstance: createCodeUiTestInstance(instanceId).localInstance,
    projects: {
      listProjects: async () => projects,
      getProject: async (_user: unknown, id: string) => ({
        id,
        kind: "code",
        work_dir: projects.find((project) => project.id === id)!.workDir,
        additional_directories: [{ path: reference, access: "read-only" }],
      }),
    },
    modelProviders: {
      listInstances: async () => [],
      listProviderPresets: () => [],
    },
    modelCatalog: { listCatalog: async () => [] },
    settings: {
      getInstanceSettings: async () =>
        instanceSettingsSchema.parse({
          defaultModel: "test",
          ...(options.searchResults
            ? { codeSearchMaxResults: options.searchResults }
            : {}),
        }),
    },
    threads: { createThreadId: randomUUID },
    env,
    taskWork: { initialize: async () => [], notifyReady: async () => {} },
  } as unknown as CodeUiServiceDeps);
  return {
    actor,
    service,
    projects,
    root,
    roots,
    createRoot,
    pathA,
    pathB,
    reference,
    firstId,
    secondId,
    taskId,
  };
}

it("共享目录必须指定Project，旧Task目录不能替默认目录猜项目", async () => {
  const { actor, service, projects, pathA, pathB, firstId, secondId } =
    await fixture();
  await expect(service.requireWorkspace(actor, pathA)).rejects.toMatchObject({
    code: "command_conflict",
  });
  expect((await service.requireWorkspace(actor, secondId)).projectId).toBe(
    secondId,
  );
  projects[0]!.workDir = pathB;
  projects[1]!.workDir = pathB;
  await expect(service.requireWorkspace(actor, pathA)).rejects.toMatchObject({
    code: "not_found",
  });
  expect((await service.requireWorkspace(actor, firstId)).path).toBe(pathB);
});

it("原CodeUI宿主订阅真实workspace目录，固定Task根A不借项目默认B重绑且不同Project不串桶", async () => {
  const f = await fixture();
  const actor = f.actor;
  f.projects[0]!.workDir = f.pathB;
  f.projects[1]!.workDir = f.pathB;
  const events: CodeUiEvent[] = [];
  const connection = await f.service.openConnection(
    actor,
    async (event) => {
      events.push(event);
    },
    () => {},
  );
  await f.service.transportRpc(
    actor,
    connection.hello.connectionId,
    "initializeConversationV4",
    [
      {
        kind: "clientHello",
        protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
        clientId: randomUUID(),
        appVersion: "test",
        clientKind: "web",
      },
    ],
  );
  const target = {
    workspacePath: f.pathA,
    projectId: f.secondId,
    workspaceIdentity: JSON.stringify([f.secondId, f.pathA]),
  };
  try {
    const subscription = await f.service.transportRpc(
      actor,
      connection.hello.connectionId,
      "subscribeWorkspaceConfigV4",
      [target],
    );
    const ack = protocol.v4WorkspaceConfigSubscribeResultSchema.parse(
      subscription?.result,
    );
    expect(events).toEqual([]);
    await subscription!.publish!();
    const event = events.find(
      (entry) => entry.event === "onDynamicWorkspaceConfigFrame",
    );
    expect(event).toMatchObject({
      workspacePath: f.pathA,
      workspaceIdentity: target.workspaceIdentity,
    });
    if (event?.event !== "onDynamicWorkspaceConfigFrame")
      throw new Error("真实配置订阅未产生原frame");
    const wire = protocol.workspaceConfigTopicWireFrameSchema.parse(
      event.frame,
    );
    if (wire.kind !== "complete" || wire.frame.payload.kind !== "snapshot")
      throw new Error("小型配置应为完整snapshot");
    expect(wire.frame.payload.snapshot).toMatchObject({
      workspaceId: target.workspaceIdentity,
      config: {
        configOptions: [
          { id: "model", currentValue: "", options: [] },
          { id: "mode", currentValue: "build" },
        ],
        slashCommands: [],
      },
    });
    await expect(
      f.service.transportRpc(
        actor,
        connection.hello.connectionId,
        "subscribeWorkspaceConfigV4",
        [
          {
            ...target,
            projectId: f.firstId,
            workspaceIdentity: JSON.stringify([f.firstId, f.pathA]),
          },
        ],
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await f.service.transportRpc(
      actor,
      connection.hello.connectionId,
      "unsubscribeWorkspaceConfigV4",
      [{ ...target, subscriptionId: ack.ack.subscriptionId }],
    );
    expect(f.createRoot).not.toHaveBeenCalled();
  } finally {
    await connection.dispose();
    await f.service.closeConnections();
  }
});

it("Window Controller真实宿主按Project与固定目录聚合，搜索旧Task正文且拒绝其它项目串入", async () => {
  const {
    actor,
    service,
    projects,
    roots,
    root,
    pathA,
    pathB,
    firstId,
    secondId,
    taskId,
  } = await fixture();
  projects[1]!.workDir = pathB;
  const other = structuredClone(root);
  other.id = randomUUID();
  other.root_session_id = other.id;
  other.project_id = firstId;
  other.state!.snapshots[0]!.sessionId = other.id;
  roots.push(other);
  const stream = await service.openConnection(
    actor,
    async () => {},
    () => {},
  );
  try {
    await service.transportRpc(
      actor,
      stream.hello.connectionId,
      "initializeConversationV4",
      [
        {
          kind: "clientHello",
          protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
          clientId: randomUUID(),
          clientKind: "web",
          appVersion: "test",
        },
      ],
    );
    const oldIdentity = JSON.stringify([secondId, pathA]);
    const query = {
      kind: "active",
      workspaceScopes: [
        { workspacePath: pathA, workspaceIdentity: oldIdentity },
        {
          workspacePath: pathB,
          workspaceIdentity: JSON.stringify([secondId, pathB]),
        },
      ],
      sortBy: "updated",
    };
    const result = await service.hostRpc(
      actor,
      "window-controller",
      "listTaskList",
      [query],
      stream.hello.connectionId,
    );
    expect(result?.result).toMatchObject({
      total: 1,
      hasMore: false,
      items: [
        {
          taskId,
          projectId: secondId,
          workspacePath: pathA,
          workspaceIdentity: oldIdentity,
        },
      ],
    });
    const searched = await service.hostRpc(
      actor,
      "window-controller",
      "listTaskList",
      [{ ...query, search: "old Task" }],
      stream.hello.connectionId,
    );
    expect(searched?.result).toMatchObject({
      total: 1,
      items: [
        {
          taskId,
          projectId: secondId,
          searchSnippets: [expect.stringContaining("old Task")],
        },
      ],
    });
    await expect(
      service.hostRpc(
        actor,
        "window-controller",
        "listTaskList",
        [{ ...query, workspaceScopes: [{ workspacePath: pathA }] }],
        stream.hello.connectionId,
      ),
    ).rejects.toMatchObject({ code: "command_conflict" });
  } finally {
    await stream.dispose();
    await service.closeConnections();
  }
});

it("同路径不同Project的真实sessions订阅共存并保留qualified身份，旧Task目录只返回自身source", async () => {
  const {
    actor,
    service,
    projects,
    roots,
    root,
    pathA,
    pathB,
    firstId,
    secondId,
    taskId,
  } = await fixture();
  projects[1]!.workDir = pathB;
  const other = structuredClone(root);
  other.id = randomUUID();
  other.root_session_id = other.id;
  other.project_id = firstId;
  other.state!.snapshots[0]!.sessionId = other.id;
  roots.push(other);
  const frames: CodeUiEvent[] = [];
  const stream = await service.openConnection(
    actor,
    async (event) => {
      frames.push(event);
    },
    () => {},
  );
  try {
    await service.transportRpc(
      actor,
      stream.hello.connectionId,
      "initializeConversationV4",
      [
        {
          kind: "clientHello",
          protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
          clientId: randomUUID(),
          clientKind: "web",
          appVersion: "test",
        },
      ],
    );
    const subscribe = (projectId: string) =>
      service.transportRpc(
        actor,
        stream.hello.connectionId,
        "subscribeSessionsIndexV4",
        [
          {
            projectId,
            workspacePath: pathA,
            workspaceIdentity: JSON.stringify([projectId, pathA]),
          },
        ],
      );
    const first = await subscribe(firstId);
    const second = await subscribe(secondId);
    await first!.publish!();
    await second!.publish!();
    const indices = frames.filter(
      (event) => event.event === "onDynamicSessionsIndexFrame",
    );
    expect(indices).toHaveLength(2);
    expect(indices[0]).toMatchObject({
      workspaceIdentity: JSON.stringify([firstId, pathA]),
    });
    expect(indices[1]).toMatchObject({
      workspaceIdentity: JSON.stringify([secondId, pathA]),
    });
    const assembler = new protocol.TopicWireFrameAssembler(
      protocol.sessionsIndexTopicFrameSchema,
    );
    const logical = indices
      .flatMap((event) => assembler.accept(event.frame))
      .flatMap((event) => (event.kind === "complete" ? [event.frame] : []));
    expect(logical).toMatchObject([
      {
        topic: protocol.sessionsIndexTopic(JSON.stringify([firstId, pathA])),
        payload: {
          snapshot: {
            workspaceId: JSON.stringify([firstId, pathA]),
            sessions: [{ sessionId: other.id }],
          },
        },
      },
      {
        topic: protocol.sessionsIndexTopic(JSON.stringify([secondId, pathA])),
        payload: {
          snapshot: {
            workspaceId: JSON.stringify([secondId, pathA]),
            sessions: [{ sessionId: taskId }],
          },
        },
      },
    ]);
  } finally {
    await stream.dispose();
    await service.closeConnections();
  }
});

it("原Task元数据可按原契约解析，未选择思考档位时省略而不传空字符串", async () => {
  const { actor, service, pathA, taskId } = await fixture();
  const result = await service.hostRpc(actor, "zcode-task", "getTaskMeta", [
    { workspacePath: pathA, taskId },
  ]);
  const meta = zcodeTaskMetaSchema.parse(result?.result);
  expect(meta.thoughtLevel).toBeUndefined();
});

it("单Task轻量元数据在工作区全量列表不可用时仍可读，保留真实项目和固定目录", async () => {
  const { actor, service, pathA, taskId, secondId } = await fixture({
    enumerationUnavailable: true,
  });
  const result = await service.hostRpc(actor, "zcode-task", "getTaskMeta", [
    { workspacePath: pathA, taskId, projectId: secondId },
  ]);
  expect(zcodeTaskMetaSchema.parse(result?.result)).toMatchObject({
    taskId,
    projectId: secondId,
    workspacePath: pathA,
    title: "old Task",
  });
});

it("明确Human创建真实空Task不依赖模型配置，首次发送仍明确拒绝不可执行模型", async () => {
  const { actor, service, pathA, secondId } = await fixture();
  const ack = await service.createSession(actor, {
    clientId: randomUUID(),
    commandId: randomUUID(),
    sessionId: null,
    type: "createSession",
    payload: { workspaceId: secondId },
    issuedAt: Date.now(),
  });
  expect(ack).toMatchObject({
    status: "accepted",
    result: { type: "createSession" },
  });
  const sessionId = (ack.result as { sessionId: string }).sessionId;
  const loaded = await service.loadConversation(actor, sessionId);
  expect(loaded.root).toMatchObject({
    id: sessionId,
    project_id: secondId,
    root_directory: pathA,
    active_run_id: null,
  });
  expect(loaded.host.getSnapshot()).toMatchObject({
    control: { phase: "draft" },
    config: { model: "" },
    rows: { window: [] },
  });
  await expect(
    service.transportRpc(actor, undefined, "sendConversationCommandV4", [
      {
        workspacePath: pathA,
        envelope: {
          clientId: randomUUID(),
          commandId: randomUUID(),
          sessionId,
          type: "sendText",
          payload: { text: "开始工作" },
          issuedAt: Date.now(),
        },
      },
    ]),
  ).rejects.toMatchObject({ message: "当前模型不可执行，请检查供应商配置" });
});

it("Controller正文搜索在最终结果限额下保留全部命中计数，不把source静默截断当作完整列表", async () => {
  const { actor, service, roots, root, pathA, secondId } = await fixture({
    searchResults: 1,
  });
  const other = structuredClone(root);
  other.id = randomUUID();
  other.root_session_id = other.id;
  other.state!.snapshots[0]!.sessionId = other.id;
  roots.push(other);
  const stream = await service.openConnection(
    actor,
    async () => {},
    () => {},
  );
  try {
    await service.transportRpc(
      actor,
      stream.hello.connectionId,
      "initializeConversationV4",
      [
        {
          kind: "clientHello",
          protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
          clientId: randomUUID(),
          clientKind: "web",
          appVersion: "test",
        },
      ],
    );
    const result = await service.hostRpc(
      actor,
      "window-controller",
      "listTaskList",
      [
        {
          kind: "active",
          workspaceScopes: [
            {
              workspacePath: pathA,
              workspaceIdentity: JSON.stringify([secondId, pathA]),
            },
          ],
          sortBy: "updated",
          search: "old Task",
          limit: 1,
        },
      ],
      stream.hello.connectionId,
    );
    expect(result?.result).toMatchObject({ total: 2, hasMore: true });
    expect(result?.result).toHaveProperty("items.length", 1);
  } finally {
    await stream.dispose();
    await service.closeConnections();
  }
});

it("Controller timeline正文搜索遵循原成员语义，不重复返回已置顶Task", async () => {
  const { actor, service, roots, root, pathA, secondId } = await fixture();
  root.pinned = true;
  const regular = structuredClone(root);
  regular.id = randomUUID();
  regular.root_session_id = regular.id;
  regular.pinned = false;
  regular.state!.snapshots[0]!.sessionId = regular.id;
  roots.push(regular);
  const stream = await service.openConnection(
    actor,
    async () => {},
    () => {},
  );
  try {
    await service.transportRpc(
      actor,
      stream.hello.connectionId,
      "initializeConversationV4",
      [
        {
          kind: "clientHello",
          protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
          clientId: randomUUID(),
          clientKind: "web",
          appVersion: "test",
        },
      ],
    );
    const result = await service.hostRpc(
      actor,
      "window-controller",
      "listTaskList",
      [
        {
          kind: "timeline",
          workspaceScopes: [
            {
              workspacePath: pathA,
              workspaceIdentity: JSON.stringify([secondId, pathA]),
            },
          ],
          sortBy: "updated",
          search: "old Task",
        },
      ],
      stream.hello.connectionId,
    );
    expect(result?.result).toMatchObject({
      total: 1,
      hasMore: false,
      items: [{ taskId: regular.id }],
    });
  } finally {
    await stream.dispose();
    await service.closeConnections();
  }
});

it("真实宿主归档Task后更新已订阅Controller成员，不等待客户端重新查询", async () => {
  const { actor, service, taskId } = await fixture();
  const events: CodeUiEvent[] = [];
  const stream = await service.openConnection(
    actor,
    async (event) => {
      events.push(event);
    },
    () => {},
  );
  try {
    await service.transportRpc(
      actor,
      stream.hello.connectionId,
      "initializeConversationV4",
      [
        {
          kind: "clientHello",
          protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
          clientId: randomUUID(),
          clientKind: "web",
          appVersion: "test",
        },
      ],
    );
    await service.hostRpc(
      actor,
      "window-controller",
      "subscribeControllerV4",
      [{ topic: protocol.CONTROLLER_TASKS_INDEX_TOPIC }],
      stream.hello.connectionId,
    );
    events.length = 0;
    await service.archiveTask(actor, taskId);
    const changes = events.flatMap((event) => {
      if (
        event.event !== "service" ||
        event.name !== "onDynamicControllerFrame"
      )
        return [];
      const frame = protocol.windowHostControllerTaskFrameSchema.parse(
        event.data,
      );
      return frame.payload.kind === "deltas" ? frame.payload.deltas : [];
    });
    expect(changes).toContainEqual(
      expect.objectContaining({
        op: "task.upserted",
        task: expect.objectContaining({
          address: expect.objectContaining({ taskId }),
          membership: { active: false, archived: true, pinned: false },
        }),
      }),
    );
  } finally {
    await stream.dispose();
    await service.closeConnections();
  }
});

it("Task元信息按真实projectId，默认A改B后显式项目列表仍返回Task固定A", async () => {
  const { actor, service, projects, pathA, pathB, firstId, secondId, taskId } =
    await fixture();
  expect(
    (
      await service.hostRpc(actor, "zcode-task", "getTaskMeta", [
        { workspacePath: pathA, taskId },
      ])
    )?.result,
  ).toMatchObject({ taskId, projectId: secondId, workspacePath: pathA });
  projects[1]!.workDir = pathB;
  expect(
    (
      await service.hostRpc(actor, "zcode-task", "listTasks", [
        { workspacePath: pathA, projectId: secondId },
      ])
    )?.result,
  ).toEqual([
    expect.objectContaining({
      taskId,
      workspacePath: pathA,
      projectId: secondId,
    }),
  ]);
  await expect(
    service.hostRpc(actor, "zcode-task", "getTaskMeta", [
      { workspacePath: pathA, taskId, projectId: firstId },
    ]),
  ).rejects.toMatchObject({ code: "not_found" });
});

it("Conversation订阅按Task项目，历史A上的index订阅用明确Project且不漂到B", async () => {
  const { actor, service, projects, pathA, pathB, firstId, secondId, taskId } =
    await fixture();
  const events: unknown[] = [];
  const connection = await service.openConnection(
    actor,
    async (event) => {
      events.push(event);
    },
    () => {},
  );
  await service.transportRpc(
    actor,
    connection.hello.connectionId,
    "initializeConversationV4",
    [
      {
        kind: "clientHello",
        protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
        clientId: randomUUID(),
        appVersion: "test",
        clientKind: "web",
      },
    ],
  );
  const subscribed = await service.transportRpc(
    actor,
    connection.hello.connectionId,
    "subscribeConversationV4",
    [{ workspacePath: pathA, sessionId: taskId, projectId: secondId }],
  );
  if (!subscribed || !("publish" in subscribed))
    throw new Error("订阅缺少真实发布回调");
  await subscribed.publish();
  expect(events).toEqual([
    expect.objectContaining({
      workspacePath: pathA,
      event: "onDynamicConversationFrame",
    }),
  ]);
  await expect(
    service.transportRpc(
      actor,
      connection.hello.connectionId,
      "subscribeConversationV4",
      [{ workspacePath: pathA, sessionId: taskId, projectId: firstId }],
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  projects[1]!.workDir = pathB;
  const index = await service.transportRpc(
    actor,
    connection.hello.connectionId,
    "subscribeSessionsIndexV4",
    [{ workspacePath: pathA, projectId: secondId }],
  );
  if (!index || !("publish" in index)) throw new Error("索引订阅缺少发布回调");
  await index.publish();
  expect(events[1]).toMatchObject({
    workspacePath: pathA,
    event: "onDynamicSessionsIndexFrame",
  });
  expect(
    (await service.sessionsIndex(actor, pathA, secondId)).sessions,
  ).toEqual([
    expect.objectContaining({ sessionId: taskId, workspaceId: pathA }),
  ]);
  connection.dispose();
});

it("新Task按选择Project UUID读取最新B/附加目录，同项目旧Task保留A", async () => {
  const {
    actor,
    service,
    projects,
    root,
    createRoot,
    pathA,
    pathB,
    reference,
    secondId,
  } = await fixture();
  projects[1]!.workDir = pathB;
  const envelope = protocol.commandEnvelopeSchema.parse({
    clientId: randomUUID(),
    commandId: randomUUID(),
    sessionId: null,
    type: "createSession",
    issuedAt: Date.now(),
    payload: {
      workspaceId: secondId,
      config: { modelSelection: { providerId: randomUUID(), modelId: "test" } },
    },
  });
  await service.createSession(actor, envelope);
  expect(createRoot).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      projectId: secondId,
      scope: expect.objectContaining({
        projectId: secondId,
        rootDirectory: pathB,
        additionalDirectories: [{ path: reference, access: "read-only" }],
      }),
    }),
  );
  expect(root.root_directory).toBe(pathA);
});
