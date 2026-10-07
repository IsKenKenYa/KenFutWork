import { setImmediate } from "node:timers/promises";
import {
  type CodeUiEvent,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "@zcode/services";
import { describe, expect, it } from "vitest";
import { CodeUiConnections } from "./connections.js";
import { CodeUiControllerHost } from "./controller.js";
import { CodeUiRepositoryError } from "./repository.js";

const projectId = "6c3695c9-796d-40a8-b20a-e2fd7a6289cb";
const oldRoot = "/projects/old";
const newRoot = "/projects/new";
const oldIdentity = '["6c3695c9-796d-40a8-b20a-e2fd7a6289cb","/projects/old"]';
const newIdentity = '["6c3695c9-796d-40a8-b20a-e2fd7a6289cb","/projects/new"]';

function task(taskId: string, workspacePath: string, title: string) {
  return {
    taskId,
    traceId: taskId,
    projectId,
    workspacePath,
    title,
    createdAt: 1,
    updatedAt: 2,
    mode: "build",
    status: "completed",
  };
}

describe("Code Controller 公共宿主", () => {
  it("同一 Project 的旧 Task 目录与新默认目录保持独立 source 和成员身份", async () => {
    const host = new CodeUiControllerHost({
      sources: async () => [
        { projectId, rootDirectory: oldRoot },
        { projectId, rootDirectory: newRoot },
      ],
      sourceCall: async (source, service, method) => {
        if (service !== "zcode-task")
          throw Object.assign(new Error("没有现存 Agent 运行时"), {
            code: ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
          });
        if (method === "listTasks") {
          return source.rootDirectory === oldRoot
            ? [task("old-task", oldRoot, "旧 Task")]
            : [task("new-task", newRoot, "新 Task")];
        }
        if (method === "listPinnedTasks" || method === "listArchivedTasks")
          return [];
        throw new Error(`非只读索引操作：${method}`);
      },
      send: async () => {},
      disposeSource: async () => {},
      deliveryFailed: (error) => {
        throw error;
      },
    });
    try {
      const result = await host.call("listTaskList", {
        kind: "active",
        workspaceScopes: [
          { workspacePath: oldRoot, workspaceIdentity: oldIdentity },
          { workspacePath: newRoot, workspaceIdentity: newIdentity },
        ],
        sortBy: "updated",
      });
      expect(result?.result).toMatchObject({
        total: 2,
        hasMore: false,
        items: [
          {
            taskId: "new-task",
            projectId,
            workspacePath: newRoot,
            workspaceIdentity: newIdentity,
          },
          {
            taskId: "old-task",
            projectId,
            workspacePath: oldRoot,
            workspaceIdentity: oldIdentity,
          },
        ],
      });
    } finally {
      await host.dispose();
    }
  });
  it("关闭 Controller 等待在途只读 source 调用，迟到结果不能恢复连接", async () => {
    let finishRead: ((value: ReturnType<typeof task>[]) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const pendingRead = new Promise<ReturnType<typeof task>[]>((resolve) => {
      finishRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const host = new CodeUiControllerHost({
      sources: async () => [{ projectId, rootDirectory: oldRoot }],
      sourceCall: async (_source, service, method) => {
        if (service !== "zcode-task")
          throw Object.assign(new Error("没有现存 Agent 运行时"), {
            code: ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
          });
        if (method === "listTasks") {
          markStarted?.();
          return pendingRead;
        }
        if (method === "listPinnedTasks" || method === "listArchivedTasks")
          return [];
        throw new Error(`非只读索引操作：${method}`);
      },
      send: async () => {},
      disposeSource: async () => {},
      deliveryFailed: (error) => {
        throw error;
      },
    });
    const listing = host.call("listTaskList", {
      kind: "active",
      workspaceScopes: [
        { workspacePath: oldRoot, workspaceIdentity: oldIdentity },
      ],
      sortBy: "updated",
    });
    const result = listing.then(
      (value) => ({ status: "fulfilled", value }),
      (error: unknown) => ({ status: "rejected", error }),
    );
    await readStarted;
    let closed = false;
    const closing = host.dispose().then(() => {
      closed = true;
    });
    try {
      await setImmediate();
      expect(closed).toBe(false);
      finishRead?.([task("late-task", oldRoot, "迟到索引")]);
      expect(await result).toMatchObject({
        status: "rejected",
        error: { code: "not_found" },
      });
      await closing;
      expect(closed).toBe(true);
    } finally {
      finishRead?.([]);
      await Promise.allSettled([result, closing]);
      await host.dispose();
    }
  });

  it("只订阅现存 sessions-index 的原 physical wire，在查询中合入 live overlay", async () => {
    const topic = protocol.sessionsIndexTopic(oldIdentity);
    const subscriptionId = "source-subscription";
    const frame = protocol.sessionsIndexTopicFrameSchema.parse({
      topic,
      subscriptionId,
      fromSeq: 0,
      toSeq: 1,
      sentAt: 3,
      payload: {
        kind: "snapshot",
        snapshot: {
          protocolVersion: 1,
          workspaceId: oldIdentity,
          logEpoch: "source-epoch",
          sessions: [
            {
              sessionId: "old-task",
              workspaceId: oldIdentity,
              title: "现存索引中的运行标题",
              phase: "running",
              sessionEnded: false,
              hasBackgroundWork: false,
              lastActivityAt: 3,
              createdAt: 1,
            },
          ],
        },
      },
    });
    const host = new CodeUiControllerHost({
      sources: async () => [{ projectId, rootDirectory: oldRoot }],
      sourceCall: async (_source, service, method, args) => {
        if (service === "zcode-task") {
          if (method === "listTasks")
            return [task("old-task", oldRoot, "持久化旧标题")];
          if (method === "listPinnedTasks" || method === "listArchivedTasks")
            return [];
        }
        if (service === "zcodeAgentService") {
          const request = args[0] as { runtimePolicy?: string };
          if (request.runtimePolicy !== "existing-only")
            throw new Error("列表观察不得启动新运行时");
          if (method === "subscribeSessionsIndexV4") {
            for (const wire of protocol.encodeTopicWireFrames(frame, {
              deliveryKind: "initial",
              topic,
              subscriptionId,
              logicalFrameId: "source-initial-frame",
              logicalFrameOrdinal: 1,
              measurePhysicalFrameBytes: (value) =>
                Buffer.byteLength(JSON.stringify(value), "utf8"),
            }))
              host.accept({
                event: "onDynamicSessionsIndexFrame",
                workspacePath: oldRoot,
                frame: wire,
              });
            return {
              ack: {
                subscriptionId,
                mode: "snapshot",
                logEpoch: "source-epoch",
              },
            };
          }
          if (method === "unsubscribeSessionsIndexV4") return undefined;
        }
        throw new Error(`非只读观察操作：${service}.${method}`);
      },
      send: async () => {},
      disposeSource: async () => {},
      deliveryFailed: (error) => {
        throw error;
      },
    });
    try {
      const result = await host.call("listTaskList", {
        kind: "active",
        workspaceScopes: [
          { workspacePath: oldRoot, workspaceIdentity: oldIdentity },
        ],
        sortBy: "updated",
      });
      expect(result?.result).toMatchObject({
        items: [
          {
            taskId: "old-task",
            title: "现存索引中的运行标题",
            liveStatus: "running",
            activity: { phase: "running", lastActivityAt: 3 },
          },
        ],
      });
    } finally {
      await host.dispose();
    }
  });

  it("原 Controller 订阅 ACK 与实际发送帧经原协议解析后保留 Project 归属", async () => {
    const sent: CodeUiEvent[] = [];
    const host = new CodeUiControllerHost({
      sources: async () => [{ projectId, rootDirectory: oldRoot }],
      sourceCall: async (_source, service, method) => {
        if (service === "zcode-task") {
          if (method === "listTasks")
            return [task("old-task", oldRoot, "真实所属 Project")];
          if (method === "listPinnedTasks" || method === "listArchivedTasks")
            return [];
        }
        if (
          service === "zcodeAgentService" &&
          method === "subscribeSessionsIndexV4"
        )
          throw Object.assign(new Error("没有现存 Agent 运行时"), {
            code: ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
          });
        throw new Error(`非只读观察操作：${service}.${method}`);
      },
      send: async (event) => {
        sent.push(event);
      },
      disposeSource: async () => {},
      deliveryFailed: (error) => {
        throw error;
      },
    });
    try {
      await host.call("listTaskList", {
        kind: "active",
        workspaceScopes: [
          { workspacePath: oldRoot, workspaceIdentity: oldIdentity },
        ],
        sortBy: "updated",
      });
      const subscribed = await host.call("subscribeControllerV4", {
        topic: protocol.CONTROLLER_TASKS_INDEX_TOPIC,
        visibility: "foreground",
      });
      expect(subscribed?.result).toMatchObject({ ack: { mode: "snapshot" } });
      await setImmediate();
      const event = sent.find(
        (candidate) =>
          candidate.event === "service" &&
          candidate.service === "window-controller" &&
          candidate.name === "onDynamicControllerFrame",
      );
      if (event?.event !== "service")
        throw new Error("原 Controller 必须发送订阅 snapshot");
      const frame = protocol.windowHostControllerTaskFrameSchema.parse(
        event.data,
      );
      expect(frame.payload).toMatchObject({
        kind: "snapshot",
        snapshot: {
          tasks: [
            {
              address: {
                taskId: "old-task",
                workspacePath: oldRoot,
                workspaceIdentity: oldIdentity,
              },
              meta: {
                taskId: "old-task",
                projectId,
                workspacePath: oldRoot,
                workspaceIdentity: oldIdentity,
              },
              membership: { active: true, pinned: false, archived: false },
            },
          ],
        },
      });
    } finally {
      await host.dispose();
    }
  });
  it("public refresh 读取同一 source 的最新索引并移除已删除来源", async () => {
    const sent: CodeUiEvent[] = [];
    let present = true;
    let title = "刷新前";
    const host = new CodeUiControllerHost({
      sources: async () =>
        present ? [{ projectId, rootDirectory: oldRoot }] : [],
      sourceCall: async (_source, service, method) => {
        if (service === "zcode-task") {
          if (method === "listTasks") return [task("old-task", oldRoot, title)];
          if (method === "listPinnedTasks" || method === "listArchivedTasks")
            return [];
        }
        if (
          service === "zcodeAgentService" &&
          method === "subscribeSessionsIndexV4"
        )
          throw Object.assign(new Error("没有现存 Agent 运行时"), {
            code: ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
          });
        throw new Error(`非只读观察操作：${service}.${method}`);
      },
      send: async (event) => {
        sent.push(event);
      },
      disposeSource: async () => {},
      deliveryFailed: (error) => {
        throw error;
      },
    });
    const deltas = () =>
      sent.flatMap((event) => {
        if (
          event.event !== "service" ||
          event.service !== "window-controller" ||
          event.name !== "onDynamicControllerFrame"
        )
          return [];
        const frame = protocol.windowHostControllerTaskFrameSchema.parse(
          event.data,
        );
        return frame.payload.kind === "deltas" ? frame.payload.deltas : [];
      });
    try {
      await host.call("listTaskList", {
        kind: "active",
        workspaceScopes: [
          { workspacePath: oldRoot, workspaceIdentity: oldIdentity },
        ],
        sortBy: "updated",
      });
      await host.call("subscribeControllerV4", {
        topic: protocol.CONTROLLER_TASKS_INDEX_TOPIC,
      });
      await setImmediate();
      sent.length = 0;
      title = "持久化后的新标题";
      await host.refresh();
      await setImmediate();
      expect(deltas()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            op: "task.upserted",
            task: expect.objectContaining({
              meta: expect.objectContaining({
                taskId: "old-task",
                title: "持久化后的新标题",
              }),
            }),
          }),
        ]),
      );
      sent.length = 0;
      present = false;
      await host.refresh();
      await setImmediate();
      expect(deltas()).toEqual([
        {
          op: "task.removed",
          address: {
            taskId: "old-task",
            workspacePath: oldRoot,
            workspaceIdentity: oldIdentity,
          },
        },
      ]);
      expect(
        (
          await host.call("listTaskList", {
            kind: "active",
            workspaceScopes: [],
            sortBy: "updated",
          })
        )?.result,
      ).toMatchObject({ items: [], total: 0 });
    } finally {
      await host.dispose();
    }
  });

  it("resync 与 unsubscribe 仅操作当前 Controller 连接拥有的订阅", async () => {
    const make = () =>
      new CodeUiControllerHost({
        sources: async () => [],
        sourceCall: async () => {
          throw new Error("空来源不得触发源调用");
        },
        send: async () => {},
        disposeSource: async () => {},
        deliveryFailed: (error) => {
          throw error;
        },
      });
    const owner = make();
    const other = make();
    try {
      const subscribed = protocol.controllerSubscribeResultSchema.parse(
        (
          await owner.call("subscribeControllerV4", {
            topic: protocol.CONTROLLER_TASKS_INDEX_TOPIC,
          })
        )?.result,
      );
      const target = {
        subscriptionId: subscribed.ack.subscriptionId,
        base: null,
        forceSnapshot: true,
      };
      await expect(
        other.call("resyncControllerV4", target),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        other.call("unsubscribeControllerV4", {
          subscriptionId: target.subscriptionId,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(
        (await owner.call("resyncControllerV4", target))?.result,
      ).toMatchObject({
        ack: { subscriptionId: target.subscriptionId, mode: "snapshot" },
      });
      await owner.call("unsubscribeControllerV4", {
        subscriptionId: target.subscriptionId,
      });
      await expect(
        owner.call("resyncControllerV4", target),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await Promise.all([owner.dispose(), other.dispose()]);
    }
  });

  it("关闭等待 ACK 迟到的真实 source 租约 unsubscribe 完成", async () => {
    const connections = new CodeUiConnections();
    let startRead: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    let startUnsubscribe: (() => void) | undefined;
    let releaseUnsubscribe: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startRead = resolve;
    });
    const read = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const unsubscribing = new Promise<void>((resolve) => {
      startUnsubscribe = resolve;
    });
    const unsubscribe = new Promise<void>((resolve) => {
      releaseUnsubscribe = resolve;
    });
    let sourceClosed = false;
    const connection = connections.open(
      "workspace",
      "actor",
      async (event) => host.accept(event),
      () => {},
      false,
      false,
    );
    connections.initialize("workspace", connection.hello.connectionId, {
      kind: "clientHello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      clientId: "readonly-controller",
      clientKind: "web",
      appVersion: "test",
    });
    const host = new CodeUiControllerHost({
      sources: async () => [{ projectId, rootDirectory: oldRoot }],
      sourceCall: async (_source, service, method, args) => {
        if (service === "zcode-task") return [];
        if (method === "subscribeSessionsIndexV4") {
          const prepared = await connections.subscribe(
            "workspace",
            connection.hello.connectionId,
            {
              topic: protocol.sessionsIndexTopic(oldIdentity),
              workspacePath: oldRoot,
              projectId,
              read: async () => {
                startRead?.();
                await read;
                return {
                  snapshot: protocol.sessionsIndexSnapshotSchema.parse({
                    protocolVersion: 1,
                    workspaceId: oldIdentity,
                    logEpoch: "source-epoch",
                    sessions: [],
                  }),
                  seq: 1,
                };
              },
            },
          );
          await prepared.publish();
          return prepared.result;
        }
        if (method === "unsubscribeSessionsIndexV4") {
          startUnsubscribe?.();
          await unsubscribe;
          connections.unsubscribe(
            "workspace",
            connection.hello.connectionId,
            (args[0] as { subscriptionId: string }).subscriptionId,
          );
          return null;
        }
        throw new Error(`非只读观察操作：${method}`);
      },
      send: async () => {},
      disposeSource: async () => {
        sourceClosed = true;
        connection.dispose();
      },
      deliveryFailed: (error) => {
        throw error;
      },
    });
    const listing = host.call("listTaskList", {
      kind: "active",
      workspaceScopes: [
        { workspacePath: oldRoot, workspaceIdentity: oldIdentity },
      ],
      sortBy: "updated",
    });
    const listed = listing.then(
      () => "returned",
      () => "rejected",
    );
    await started;
    let closed = false;
    const closing = host.dispose().then(() => {
      closed = true;
    });
    try {
      releaseRead?.();
      await unsubscribing;
      await setImmediate();
      expect({ closed, sourceClosed }).toEqual({
        closed: false,
        sourceClosed: false,
      });
      releaseUnsubscribe?.();
      await closing;
      expect(await listed).toBe("rejected");
      expect(sourceClosed).toBe(true);
    } finally {
      releaseRead?.();
      releaseUnsubscribe?.();
      await Promise.allSettled([listed, closing]);
      connection.dispose();
      await host.dispose();
    }
  });

  it("可信 local source 的搜索预算错误可读拒绝，不能被原核吞成空结果", async () => {
    let blocked = true;
    const host = new CodeUiControllerHost({
      sources: async () => [{ projectId, rootDirectory: oldRoot }],
      sourceCall: async (_source, service, method) => {
        if (service === "zcode-task") {
          if (method === "listTasks")
            return [task("old-task", oldRoot, "needle")];
          if (method === "listPinnedTasks" || method === "listArchivedTasks")
            return [];
          if (method === "listTaskList") {
            if (blocked)
              throw new CodeUiRepositoryError(
                "command_conflict",
                "会话搜索超过工作区读取预算，请缩小项目范围。",
              );
            return {
              items: [task("old-task", oldRoot, "needle")],
              total: 1,
              hasMore: false,
            };
          }
        }
        if (
          service === "zcodeAgentService" &&
          method === "subscribeSessionsIndexV4"
        )
          throw Object.assign(new Error("没有现存 Agent 运行时"), {
            code: ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
          });
        throw new Error(`非只读观察操作：${service}.${method}`);
      },
      send: async () => {},
      disposeSource: async () => {},
      deliveryFailed: (error) => {
        throw error;
      },
    });
    const query = {
      kind: "active",
      workspaceScopes: [
        { workspacePath: oldRoot, workspaceIdentity: oldIdentity },
      ],
      sortBy: "updated",
      search: "needle",
    };
    try {
      await expect(host.call("listTaskList", query)).rejects.toMatchObject({
        code: "command_conflict",
        message: "会话搜索超过工作区读取预算，请缩小项目范围。",
      });
      blocked = false;
      expect((await host.call("listTaskList", query))?.result).toMatchObject({
        items: [{ taskId: "old-task", title: "needle" }],
        total: 1,
      });
    } finally {
      await host.dispose();
    }
  });

  it("同路径两个 Project 保持两组身份，raw path 歧义与伪造 qualified target 拒绝", async () => {
    const otherProjectId = "2301a5bc-e912-44e8-8b7f-e8df9703945e";
    const otherIdentity =
      '["2301a5bc-e912-44e8-8b7f-e8df9703945e","/projects/old"]';
    const host = new CodeUiControllerHost({
      sources: async () => [
        { projectId, rootDirectory: oldRoot },
        { projectId: otherProjectId, rootDirectory: oldRoot },
      ],
      sourceCall: async (source, service, method) => {
        if (service === "zcode-task") {
          if (method === "listTasks")
            return [
              {
                ...task(
                  source.projectId === projectId ? "old-task" : "other-task",
                  oldRoot,
                  "同路径来源",
                ),
                projectId: source.projectId,
              },
            ];
          if (method === "listPinnedTasks" || method === "listArchivedTasks")
            return [];
        }
        if (
          service === "zcodeAgentService" &&
          method === "subscribeSessionsIndexV4"
        )
          throw Object.assign(new Error("没有现存 Agent 运行时"), {
            code: ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
          });
        throw new Error(`非只读观察操作：${service}.${method}`);
      },
      send: async () => {},
      disposeSource: async () => {},
      deliveryFailed: (error) => {
        throw error;
      },
    });
    try {
      await expect(
        host.call("listTaskList", {
          kind: "active",
          workspaceScopes: [{ workspacePath: oldRoot }],
          sortBy: "updated",
        }),
      ).rejects.toMatchObject({ code: "command_conflict" });
      const result = await host.call("listTaskList", {
        kind: "active",
        workspaceScopes: [
          { workspacePath: oldRoot, workspaceIdentity: oldIdentity },
          { workspacePath: oldRoot, workspaceIdentity: otherIdentity },
        ],
        sortBy: "updated",
      });
      expect(result?.result).toMatchObject({
        total: 2,
        items: [
          { taskId: "old-task", projectId, workspaceIdentity: oldIdentity },
          {
            taskId: "other-task",
            projectId: otherProjectId,
            workspaceIdentity: otherIdentity,
          },
        ],
      });
      await expect(
        host.call("listTaskList", {
          kind: "active",
          workspaceScopes: [
            { workspacePath: newRoot, workspaceIdentity: otherIdentity },
          ],
          sortBy: "updated",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await host.call("execute", { command: "whoami" })).toBeNull();
    } finally {
      await host.dispose();
    }
  });

  it("并发 refresh 的旧来源名单不能覆盖后来的 Project 默认目录", async () => {
    let current = [{ projectId, rootDirectory: oldRoot }];
    let holdNext = false;
    let markStarted: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = new CodeUiControllerHost({
      sources: async () => {
        const snapshot = current.map((source) => ({ ...source }));
        if (holdNext) {
          holdNext = false;
          markStarted?.();
          await blocked;
        }
        return snapshot;
      },
      sourceCall: async (source, service, method) => {
        if (service === "zcode-task") {
          if (method === "listTasks")
            return [
              task(
                source.rootDirectory === oldRoot ? "old-task" : "new-task",
                source.rootDirectory,
                "来源名单成员",
              ),
            ];
          if (method === "listPinnedTasks" || method === "listArchivedTasks")
            return [];
        }
        if (
          service === "zcodeAgentService" &&
          method === "subscribeSessionsIndexV4"
        )
          throw Object.assign(new Error("没有现存 Agent 运行时"), {
            code: ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
          });
        throw new Error(`非只读观察操作：${service}.${method}`);
      },
      send: async () => {},
      disposeSource: async () => {},
      deliveryFailed: (error) => {
        throw error;
      },
    });
    const query = (root: string, identity: string) => ({
      kind: "active",
      workspaceScopes: [{ workspacePath: root, workspaceIdentity: identity }],
      sortBy: "updated",
    });
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      await host.call("listTaskList", query(oldRoot, oldIdentity));
      holdNext = true;
      first = host.refresh();
      await started;
      current = [{ projectId, rootDirectory: newRoot }];
      second = host.refresh();
      release?.();
      await Promise.all([first, second]);
      expect(
        (await host.call("listTaskList", query(newRoot, newIdentity)))?.result,
      ).toMatchObject({
        total: 1,
        items: [
          {
            taskId: "new-task",
            workspacePath: newRoot,
            workspaceIdentity: newIdentity,
          },
        ],
      });
      await expect(
        host.call("listTaskList", query(oldRoot, oldIdentity)),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      release?.();
      await Promise.allSettled([first, second]);
      await host.dispose();
    }
  });
});
