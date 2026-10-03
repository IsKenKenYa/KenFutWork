import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { nextHostServiceEvent, request } from "./host-client.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";

async function nextControllerFrame(
  host: Awaited<ReturnType<typeof createCodeSessionFixture>>,
) {
  const event = await nextHostServiceEvent(
    host.stream,
    "window-controller",
    "onDynamicControllerFrame",
  );
  return protocol.windowHostControllerTaskFrameSchema.parse(event.data);
}

async function nextTaskUpsert(
  host: Awaited<ReturnType<typeof createCodeSessionFixture>>,
) {
  for (;;) {
    const frame = await nextControllerFrame(host);
    if (frame.payload.kind !== "deltas") continue;
    const delta = frame.payload.deltas.find(
      (delta) =>
        delta.op === "task.upserted" &&
        delta.task.address.taskId === host.sessionId,
    );
    if (delta?.op === "task.upserted") return delta.task;
  }
}

describe.skipIf(!enabled)("原任务目录公开宿主 integration", () => {
  it("原 Controller 订阅返回原 ACK 与 snapshot，任务创建后发送原投影 delta 并能实时查询", async () => {
    const model = await heldModel();
    const host = await createCodeSessionFixture(model.baseUrl);
    const controller = (method: string, args: unknown[]) =>
      request("/api/code-ui/rpc", {
        service: "window-controller",
        method,
        args,
        connectionId: host.stream.ready.hello.connectionId,
      });
    try {
      const subscribed = await controller("subscribeControllerV4", [
        {
          topic: "controller/tasks-index",
          visibility: "foreground",
        },
      ]);
      expect(subscribed.status, JSON.stringify(subscribed.body)).toBe(200);
      const first = await nextHostServiceEvent(
        host.stream,
        "window-controller",
        "onDynamicControllerFrame",
      );
      expect(first).toMatchObject({
        event: "service",
        service: "window-controller",
        name: "onDynamicControllerFrame",
        data: {
          subscriptionId: subscribed.body.result.ack.subscriptionId,
          topic: "controller/tasks-index",
          payload: { kind: "snapshot" },
        },
      });
      const query = {
        kind: "active",
        workspaceScopes: [{ workspacePath: host.workspacePath }],
        sortBy: "updated",
      };
      expect(
        (await controller("listTaskList", [query])).body.result.items,
      ).toEqual([]);
      await host.command("sendText", { text: "原 Controller 热任务" });
      const upsert = await nextTaskUpsert(host);
      expect(upsert).toMatchObject({
        address: { taskId: host.sessionId, workspacePath: host.workspacePath },
        meta: { title: "原 Controller 热任务" },
        membership: { pinned: false, archived: false, active: true },
        sourceAvailability: "online",
        liveStatus: "running",
      });
      const live = await controller("listTaskList", [query]);
      expect(live.body.result).toMatchObject({
        total: 1,
        hasMore: false,
        items: [
          {
            taskId: host.sessionId,
            title: "原 Controller 热任务",
            liveStatus: "running",
          },
        ],
      });
      const resynced = await controller("resyncControllerV4", [
        {
          subscriptionId: subscribed.body.result.ack.subscriptionId,
          base: null,
          forceSnapshot: true,
        },
      ]);
      expect(resynced.status).toBe(200);
      expect(resynced.body.result.ack.subscriptionId).toBe(
        subscribed.body.result.ack.subscriptionId,
      );
      let recovered = await nextControllerFrame(host);
      while (recovered.payload.kind !== "snapshot")
        recovered = await nextControllerFrame(host);
      expect(recovered.payload.snapshot.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            address: expect.objectContaining({ taskId: host.sessionId }),
          }),
        ]),
      );
      expect(
        (
          await controller("unsubscribeControllerV4", [
            { subscriptionId: subscribed.body.result.ack.subscriptionId },
          ])
        ).status,
      ).toBe(200);
      await host.command("stop", {});
    } finally {
      await host.command("stop", {});
      await model.close();
      await host.dispose();
    }
  });
  it("Controller 游标和工作目录只归当前连接；非法归属、查询参数和已释放租约被拒绝", async () => {
    const host = await createCodeSessionFixture("https://example.invalid/v1");
    const controller = (method: string, args: unknown[]) =>
      request("/api/code-ui/rpc", {
        service: "window-controller",
        method,
        args,
        connectionId: host.stream.ready.hello.connectionId,
      });
    try {
      expect(
        (
          await controller("listTaskList", [
            {
              kind: "active",
              workspaceScopes: [{ workspacePath: "/不属于本工作区" }],
              sortBy: "updated",
            },
          ])
        ).status,
      ).toBe(404);
      expect(
        (
          await controller("listTaskList", [
            { kind: "invalid", workspaceScopes: [], sortBy: "updated" },
          ])
        ).status,
      ).toBe(400);
      const foreign = await controller("resyncControllerV4", [
        { subscriptionId: "foreign", base: null },
      ]);
      expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
      const subscribe = await controller("subscribeControllerV4", [
        { topic: "controller/tasks-index" },
      ]);
      await nextHostServiceEvent(
        host.stream,
        "window-controller",
        "onDynamicControllerFrame",
      );
      const id = subscribe.body.result.ack.subscriptionId;
      expect(
        (await controller("unsubscribeControllerV4", [{ subscriptionId: id }]))
          .status,
      ).toBe(200);
      expect(
        (
          await controller("resyncControllerV4", [
            { subscriptionId: id, base: null },
          ])
        ).status,
      ).toBe(404);
      expect(
        (
          await request("/api/code-ui/rpc", {
            service: "window-controller",
            method: "subscribeControllerV4",
            args: [{ topic: "controller/tasks-index" }],
            connectionId: "closed-connection",
          })
        ).status,
      ).toBe(404);
    } finally {
      await host.dispose();
    }
  });
  it.skipIf(!process.env.CODE_UI_TEST_DATABASE_URL)(
    "Controller 目录读取等待期间关闭通知，迟到订阅拒绝且不能产生无载体 ACK",
    async () => {
      const host = await createCodeSessionFixture("https://example.invalid/v1");
      const delay = new Client({
        connectionString: process.env.CODE_UI_TEST_DATABASE_URL,
      });
      let pending: ReturnType<typeof request> | undefined;
      try {
        await delay.connect();
        await delay.query("begin");
        // 独占测试库的外部故障注入，只延迟目录读取；行为断言仍走公开 HTTP/SSE。
        await delay.query(
          "lock table public.projects in access exclusive mode",
        );
        pending = request("/api/code-ui/rpc", {
          service: "window-controller",
          method: "subscribeControllerV4",
          args: [{ topic: "controller/tasks-index" }],
          connectionId: host.stream.ready.hello.connectionId,
        });
        await vi.waitFor(async () => {
          const waiting = await delay.query(
            "select 1 from pg_locks where granted=false and relation='public.projects'::regclass",
          );
          if (!waiting.rows.length)
            throw new Error("等待 Controller 到达目录延迟点");
        });
        host.stream.controller.abort();
        await vi.waitFor(async () => {
          const closed = await host.stream.rpc("initializeConversationV4", [
            {
              kind: "clientHello",
              protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
              clientId: "closed-controller-probe",
              appVersion: "integration",
              clientKind: "web",
            },
          ]);
          expect(closed.status).toBe(404);
        });
        await delay.query("commit");
        const late = await pending;
        expect(late.status, JSON.stringify(late.body)).toBe(404);
        expect(late.body.result).toBeUndefined();
      } finally {
        await delay.query("rollback").catch(() => {});
        await delay.end();
        await pending;
        await host.dispose();
      }
    },
  );
  it("首条输入建立任务集合时发送原 task_created，原目录无需刷新即可重读新任务", async () => {
    const model = await heldModel();
    const host = await createCodeSessionFixture(model.baseUrl);
    try {
      const sent = await host.command("sendText", {
        text: "首次目录热更新验收",
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      const event = await nextHostServiceEvent(
        host.stream,
        "zcode-task",
        "onDynamicWorkspaceEvent",
        { workspacePath: host.workspacePath, taskId: host.sessionId },
      );
      expect(event).toMatchObject({
        event: "service",
        service: "zcode-task",
        name: "onDynamicWorkspaceEvent",
        data: {
          reason: "task_created",
          taskId: host.sessionId,
          taskMeta: { title: "首次目录热更新验收", status: "running" },
        },
      });
      await vi.waitFor(async () => {
        const snapshot = await host.snapshot();
        expect(
          snapshot.rows.window.some(
            (row: { kind: string; text?: string }) =>
              row.kind === "assistantText" && row.text === "正在运行 1",
          ),
        ).toBe(true);
      });
      const stopped = await host.command("stop", {});
      expect(stopped.body.result.status).toBe("accepted");
    } finally {
      await host.command("stop", {});
      await model.close();
      await host.dispose();
    }
  });
});
