import { randomUUID } from "node:crypto";
import {
  zcodeUiProtocol as protocol,
  providerInstanceResponseSchema,
} from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/types.js";
import { CodeUiConnections } from "./connections.js";
import { buildCodeUiModelViews } from "./model-views.js";
import {
  type CodeUiWorkspaceConfigRequest,
  createCodeUiWorkspaceConfigHost,
} from "./workspace-config.js";

function fixture(
  shared: {
    workspaceId?: string;
    actor?: AuthenticatedUser;
    connections?: CodeUiConnections;
  } = {},
) {
  const workspaceId = shared.workspaceId ?? randomUUID();
  const projectId = randomUUID();
  const actor = shared.actor ?? {
    id: randomUUID(),
    email: "workspace-config@test",
    accessToken: "private",
    userMetadata: {},
  };
  const path = "/owned/project";
  const identity = JSON.stringify([projectId, path]);
  const events: unknown[] = [];
  const connections = shared.connections ?? new CodeUiConnections();
  const carrier = connections.open(
    workspaceId,
    actor.id,
    async (event) => {
      events.push(event);
    },
    () => {},
  );
  connections.initialize(workspaceId, carrier.hello.connectionId, {
    kind: "clientHello",
    protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
    clientId: randomUUID(),
    appVersion: "test",
    clientKind: "web",
  });
  const connection = {
    workspaceId,
    userId: actor.id,
    connectionId: carrier.hello.connectionId,
  };
  const instance = providerInstanceResponseSchema.parse({
    id: randomUUID(),
    name: "用户供应商",
    scope: "workspace",
    protocol: "openai-compatible",
    enabled: true,
    hasCredential: true,
    configRevision: 1,
    headerKeys: [],
    models: [
      {
        id: "real-model",
        name: "Actual",
        capability: "chat",
        reasoningEfforts: ["low", "high"],
      },
    ],
  });
  let available = true;
  let presentation = {
    mode: "plan",
    slashCommands: [
      { name: "inspect", description: "检查项目", source: "custom" as const },
    ],
  };
  const views = vi.fn(async () =>
    buildCodeUiModelViews({
      instances: [instance],
      catalog: [],
      defaultSpecifier: `${instance.id}:real-model`,
    }),
  );
  const resolve = vi.fn(
    async (user: AuthenticatedUser, request: CodeUiWorkspaceConfigRequest) => {
      if (
        !available ||
        user.id !== actor.id ||
        request.projectId !== projectId ||
        request.workspacePath !== path
      )
        throw new Error("Project不属于当前可信用户或已经归档。");
      return { workspaceId, projectId, workspacePath: path };
    },
  );
  const createHost = () =>
    createCodeUiWorkspaceConfigHost({
      connections,
      resolveTarget: resolve,
      modelViews: views,
      readPresentation: async () => presentation,
    });
  const host = createHost();
  const params = {
    projectId,
    workspacePath: path,
    workspaceIdentity: identity,
  };
  return {
    host,
    params,
    actor,
    connection,
    carrier,
    connections,
    events,
    views,
    resolve,
    instance,
    workspaceId,
    restartHost: createHost,
    setPresentation(value: typeof presentation) {
      presentation = value;
    },
    archive() {
      available = false;
    },
  };
}

async function subscribe(f: ReturnType<typeof fixture>, params = f.params) {
  const response = await f.host.call(
    f.actor,
    "subscribeWorkspaceConfigV4",
    [params],
    f.connection,
  );
  if (!response || !("publish" in response))
    throw new Error("公开订阅未返回真实post-response publish。");
  return response;
}

function frame(event: unknown) {
  if (!event || typeof event !== "object" || !("frame" in event))
    throw new Error("缺少真实frame事件。");
  const wire = protocol.workspaceConfigTopicWireFrameSchema.parse(event.frame);
  if (wire.kind !== "complete") throw new Error("小型夹具意外分片。");
  if (wire.frame.payload.kind !== "snapshot")
    throw new Error("配置目录必须是conflated完整态。");
  return { wire, frame: wire.frame, snapshot: wire.frame.payload.snapshot };
}

it("公开workspace-config ACK-only后才发第三型frame，真实模型/模式/档位/slash来源且不回读Key", async () => {
  const f = fixture();
  const subscribed = await subscribe(f);
  expect(
    protocol.v4WorkspaceConfigSubscribeResultSchema.parse(subscribed.result),
  ).toEqual(subscribed.result);
  expect(f.events).toEqual([]);
  await subscribed.publish();
  expect(f.events[0]).toMatchObject({
    event: "onDynamicWorkspaceConfigFrame",
    workspacePath: f.params.workspacePath,
    workspaceIdentity: f.params.workspaceIdentity,
  });
  const output = frame(f.events[0]);
  expect(output.wire).toMatchObject({
    deliveryKind: "initial",
    subscriptionId: subscribed.result.ack.subscriptionId,
    topic: protocol.workspaceConfigTopic(f.params.workspaceIdentity),
  });
  expect(output.snapshot.config.configOptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "model",
        options: [
          expect.objectContaining({
            modelProviderId: f.instance.id,
            name: "real-model",
            modelThoughtLevels: ["low", "high"],
          }),
        ],
      }),
      expect.objectContaining({ id: "mode", currentValue: "plan" }),
      expect.objectContaining({ id: "thought_level", currentValue: "high" }),
    ]),
  );
  expect(output.snapshot.config.slashCommands).toEqual([
    { name: "inspect", description: "检查项目", source: "custom" },
  ]);
  expect(JSON.stringify(output)).not.toContain('"apiKey":');
});

it("真实provider停用与命令更新刷新同租约conflated最新态，resync仍ACK-only且退订不再送帧", async () => {
  const f = fixture();
  const subscribed = await subscribe(f);
  await subscribed.publish();
  f.instance.enabled = false;
  f.setPresentation({
    mode: "build",
    slashCommands: [
      { name: "build", description: "新的真实命令", source: "custom" },
    ],
  });
  await f.host.refresh(f.workspaceId);
  const update = frame(f.events[1]);
  expect(update.wire.deliveryKind).toBe("online");
  expect(update.frame.toSeq).toBeGreaterThan(frame(f.events[0]).frame.toSeq);
  expect(
    update.snapshot.config.configOptions.find(
      (option) => option.id === "model",
    ),
  ).toMatchObject({ currentValue: "", options: [] });
  expect(update.snapshot.config.slashCommands).toEqual([
    { name: "build", description: "新的真实命令", source: "custom" },
  ]);
  const recovered = await f.host.call(
    f.actor,
    "resyncWorkspaceConfigV4",
    [
      {
        ...f.params,
        subscriptionId: subscribed.result.ack.subscriptionId,
        base: { logEpoch: "old-process", seq: 0 },
      },
    ],
    f.connection,
  );
  if (!recovered || !("publish" in recovered))
    throw new Error("resync缺少真实publish。");
  expect(f.events).toHaveLength(2);
  await recovered.publish();
  expect(frame(f.events[2]).wire.deliveryKind).toBe("recovery");
  await f.host.call(
    f.actor,
    "unsubscribeWorkspaceConfigV4",
    [{ ...f.params, subscriptionId: subscribed.result.ack.subscriptionId }],
    f.connection,
  );
  await f.host.refresh(f.workspaceId);
  expect(f.events).toHaveLength(3);
});

it("刷新已送出最新态后，迟到initial与recovery不得倒退配置；同seq恢复仍可交付", async () => {
  const f = fixture();
  const subscribed = await subscribe(f);
  f.setPresentation({
    mode: "edit",
    slashCommands: [],
  });
  await f.host.refresh(f.workspaceId);
  expect(frame(f.events[0]).snapshot.config.configOptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "mode", currentValue: "edit" }),
    ]),
  );
  await subscribed.publish();
  expect(f.events).toHaveLength(1);
  const recovery = await f.host.call(
    f.actor,
    "resyncWorkspaceConfigV4",
    [
      {
        ...f.params,
        subscriptionId: subscribed.result.ack.subscriptionId,
        base: { logEpoch: "previous-process", seq: 0 },
      },
    ],
    f.connection,
  );
  if (!recovery || !("publish" in recovery))
    throw new Error("resync缺少真实publish。");
  f.setPresentation({ mode: "yolo", slashCommands: [] });
  await f.host.refresh(f.workspaceId);
  await recovery.publish();
  expect(f.events).toHaveLength(2);
  const current = await f.host.call(
    f.actor,
    "resyncWorkspaceConfigV4",
    [
      {
        ...f.params,
        subscriptionId: subscribed.result.ack.subscriptionId,
        base: {
          logEpoch: frame(f.events[1]).snapshot.logEpoch,
          seq: frame(f.events[1]).frame.toSeq,
        },
      },
    ],
    f.connection,
  );
  if (!current || !("publish" in current))
    throw new Error("同seq resync缺少真实publish。");
  await current.publish();
  expect(f.events).toHaveLength(3);
  expect(frame(f.events[2]).wire.deliveryKind).toBe("recovery");
  expect(frame(f.events[2]).frame.toSeq).toBe(frame(f.events[1]).frame.toSeq);
});

it("配置host换代的新epoch从seq零正确开始，旧lease迟到帧不得覆盖", async () => {
  const f = fixture();
  const original = await subscribe(f);
  await original.publish();
  f.setPresentation({ mode: "edit", slashCommands: [] });
  await f.host.refresh(f.workspaceId);
  expect(frame(f.events[1]).frame.toSeq).toBeGreaterThan(0);
  const replacement = await subscribe({ ...f, host: f.restartHost() });
  await replacement.publish();
  const fresh = frame(f.events[2]);
  expect(fresh.frame.toSeq).toBe(0);
  expect(fresh.snapshot.logEpoch).not.toBe(
    frame(f.events[1]).snapshot.logEpoch,
  );
  expect(fresh.wire.subscriptionId).toBe(replacement.result.ack.subscriptionId);
  await original.publish();
  expect(f.events).toHaveLength(3);
});

it("modelViews在途时发生mutation，refresh排队重新读取最新目录，不复用旧读", async () => {
  const f = fixture();
  const subscribed = await subscribe(f);
  await subscribed.publish();
  let finish: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    f.views.mockImplementationOnce(async () => {
      const captured = buildCodeUiModelViews({
        instances: [f.instance],
        catalog: [],
      });
      resolve();
      await new Promise<void>((done) => {
        finish = done;
      });
      return captured;
    });
  });
  const recovery = f.host.call(
    f.actor,
    "resyncWorkspaceConfigV4",
    [
      {
        ...f.params,
        subscriptionId: subscribed.result.ack.subscriptionId,
        base: { logEpoch: "previous-process", seq: 0 },
      },
    ],
    f.connection,
  );
  await entered;
  f.instance.enabled = false;
  const refreshing = f.host.refresh(f.workspaceId);
  finish?.();
  const recovered = await recovery;
  await refreshing;
  expect(f.views.mock.calls.length).toBeGreaterThan(2);
  expect(frame(f.events[1]).snapshot.config.configOptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "model", currentValue: "", options: [] }),
    ]),
  );
  if (!recovered || !("publish" in recovered))
    throw new Error("延迟resync缺少真实publish。");
  await recovered.publish();
  expect(f.events).toHaveLength(3);
  expect(frame(f.events[2]).wire.deliveryKind).toBe("recovery");
  expect(frame(f.events[2]).snapshot.config).toEqual(
    frame(f.events[1]).snapshot.config,
  );
  expect(frame(f.events[2]).frame.toSeq).toBe(frame(f.events[1]).frame.toSeq);
});

it("initial订阅读取目录期间发生mutation，尚未注册lease也必须重读最新源后ACK", async () => {
  const f = fixture();
  let finish: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    f.views.mockImplementationOnce(async () => {
      const captured = buildCodeUiModelViews({
        instances: [f.instance],
        catalog: [],
      });
      resolve();
      await new Promise<void>((done) => {
        finish = done;
      });
      return captured;
    });
  });
  const initial = subscribe(f);
  await entered;
  f.instance.enabled = false;
  await f.host.refresh(f.workspaceId);
  finish?.();
  const subscribed = await initial;
  expect(f.views.mock.calls.length).toBeGreaterThan(1);
  expect(f.events).toEqual([]);
  await subscribed.publish();
  expect(frame(f.events[0]).snapshot.config.configOptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "model", currentValue: "", options: [] }),
    ]),
  );
});

it("单个归档订阅真实失败隔离，其余Project继续送帧；source消费者仅dispose失败lease", async () => {
  const archived = fixture();
  const healthy = fixture({
    workspaceId: archived.workspaceId,
    actor: archived.actor,
    connections: archived.connections,
  });
  const failedLease = await subscribe(archived);
  const liveLease = await subscribe(healthy);
  await failedLease.publish();
  await liveLease.publish();
  archived.archive();
  healthy.setPresentation({ mode: "edit", slashCommands: [] });
  const failures = await healthy.host.refresh(healthy.workspaceId);
  expect(healthy.events).toHaveLength(2);
  expect(archived.events).toHaveLength(1);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({
    connectionId: archived.connection.connectionId,
    subscriptionId: failedLease.result.ack.subscriptionId,
    projectId: archived.params.projectId,
    error: expect.objectContaining({
      message: expect.stringContaining("Project"),
    }),
  });
  failures[0]?.dispose();
  expect(
    archived.connections.require(
      archived.workspaceId,
      archived.connection.connectionId,
    ).subscriptions.size,
  ).toBe(0);
  const next = await healthy.host.refresh(healthy.workspaceId);
  expect(next).toEqual([]);
  expect(
    healthy.connections.require(
      healthy.workspaceId,
      healthy.connection.connectionId,
    ).subscriptions.size,
  ).toBe(1);
  expect(healthy.events).toHaveLength(3);
});

it("归档后的精确owned退订仍能释放lease，同topic错Project不能resync或退订", async () => {
  const first = fixture();
  const second = fixture({
    workspaceId: first.workspaceId,
    actor: first.actor,
    connections: first.connections,
  });
  const owned = await subscribe(first);
  const wrongProject = {
    ...second.params,
    workspaceIdentity: first.params.workspaceIdentity,
    subscriptionId: owned.result.ack.subscriptionId,
    base: { logEpoch: "previous-process", seq: 0 },
  };
  await expect(
    second.host.call(
      second.actor,
      "resyncWorkspaceConfigV4",
      [wrongProject],
      first.connection,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    second.host.call(
      second.actor,
      "unsubscribeWorkspaceConfigV4",
      [wrongProject],
      first.connection,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  first.archive();
  await expect(
    first.host.call(
      first.actor,
      "unsubscribeWorkspaceConfigV4",
      [{ ...first.params, subscriptionId: owned.result.ack.subscriptionId }],
      first.connection,
    ),
  ).resolves.toEqual({ result: null });
  await owned.publish();
  expect(first.events).toEqual([]);
  expect(
    first.connections.require(first.workspaceId, first.connection.connectionId)
      .subscriptions.size,
  ).toBe(0);
});

it("重订阅替换只认新lease，关闭连接后迟到publish无帧；source异常不能假空ACK", async () => {
  const f = fixture();
  const old = await subscribe(f);
  const current = await subscribe(f);
  await old.publish();
  expect(f.events).toEqual([]);
  await current.publish();
  expect(frame(f.events[0]).wire.subscriptionId).toBe(
    current.result.ack.subscriptionId,
  );
  f.carrier.dispose();
  await current.publish();
  expect(f.events).toHaveLength(1);
  const failed = fixture();
  failed.views.mockRejectedValueOnce(new Error("真实目录读取失败"));
  await expect(subscribe(failed)).rejects.toThrow("真实目录读取失败");
  expect(failed.events).toEqual([]);
  expect(
    failed.connections.require(
      failed.workspaceId,
      failed.connection.connectionId,
    ).subscriptions.size,
  ).toBe(0);
});

it("foreign actor/连接/Project与跨主题subId拒绝，读期间归档不会交付迟到ACK", async () => {
  const f = fixture();
  const subscribed = await subscribe(f);
  await expect(
    f.host.call(
      { ...f.actor, id: randomUUID() },
      "subscribeWorkspaceConfigV4",
      [f.params],
      f.connection,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    f.host.call(
      f.actor,
      "resyncWorkspaceConfigV4",
      [
        {
          ...f.params,
          workspaceIdentity: "other-topic",
          subscriptionId: subscribed.result.ack.subscriptionId,
          base: { logEpoch: "x", seq: 0 },
        },
      ],
      f.connection,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  let finish: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    f.views.mockImplementationOnce(async () => {
      resolve();
      await new Promise<void>((done) => {
        finish = done;
      });
      return buildCodeUiModelViews({ instances: [f.instance], catalog: [] });
    });
  });
  const late = subscribe(f);
  const rejection = expect(late).rejects.toThrow("Project");
  await entered;
  f.archive();
  finish?.();
  await rejection;
  expect(f.events).toEqual([]);
});
