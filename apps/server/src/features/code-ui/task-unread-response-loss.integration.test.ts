import {
  applicationErrorResponseSchema,
  type CodeTaskUnreadInput,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { zcodeTaskMetaSchema } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { createCommitResponseLossProxy } from "./pg-commit-response-loss.fixture.mjs";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type Proxy = Awaited<ReturnType<typeof createCommitResponseLossProxy>>;
const taskMetaSchema = zcodeTaskMetaSchema.extend({
  lastUnreadAt: z.number().int().nonnegative().safe(),
});
type TaskMeta = z.infer<typeof taskMetaSchema>;

function unreadIntent(meta: TaskMeta, unread: boolean): CodeTaskUnreadInput {
  if (!meta.workspaceIdentity || !meta.taskControl)
    throw new Error("未读回包验收缺少公开 Task 身份。");
  return {
    taskId: meta.taskId,
    workspacePath: meta.workspacePath,
    workspaceIdentity: meta.workspaceIdentity,
    taskControl: structuredClone(meta.taskControl),
    observedLastUnreadAt: meta.lastUnreadAt,
    unread,
    ...(!unread && meta.unreadAt !== undefined
      ? { expectedUnreadAt: meta.unreadAt }
      : {}),
  };
}

async function readMeta(host: Host) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "getTaskMeta",
    args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return taskMetaSchema.parse(response.body.result);
}

async function changeUnread(host: Host, input: CodeTaskUnreadInput) {
  return host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "setTaskUnread",
    args: [input],
  });
}

async function acceptedUnread(host: Host, input: CodeTaskUnreadInput) {
  const response = await changeUnread(host, input);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return taskMetaSchema.parse(response.body.result);
}

async function expectCurrentMarker(host: Host, meta: TaskMeta) {
  expect(await readMeta(host)).toEqual(meta);
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const task = codeProjectTreeSchema
    .parse(response.body.result)
    .tasks.find((entry) => entry.taskId === host.sessionId);
  if (!task) throw new Error("公开项目树缺少未读回包验收 Task。");
  expect(task.unreadAt).toBe(meta.unreadAt);
  expect(task.lastUnreadAt).toBe(meta.lastUnreadAt);
  expect(task.taskControl).toEqual(meta.taskControl);
}

async function readScope(host: Host) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function publishTask(fixture: Fixture, host: Host, model: Model) {
  const response = await host.command("sendText", {
    text: "未读提交丢包后保持的用户正文",
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(response.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  }); // 只等待本例真实本机模型 HTTP 请求，不属于产品治理值。
  model.writeText(0, "未读提交丢包后保持的助手正文");
  await vi.waitFor(
    async () =>
      expect(
        JSON.stringify((await snapshot(fixture, host.sessionId)).rows.window),
      ).toContain("未读提交丢包后保持的助手正文"),
    { timeout: 30_000 },
  ); // 本例真实流式正文发表后才停止，不读取未发表的模型片段。
  const stopped = await host.command("stop", {});
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(stopped.body.result).status).toBe(
    "accepted",
  );
  await waitPhase(fixture, host.sessionId, "completedInterrupted");
  await vi.waitFor(() => expect(model.requests[0]?.closed).toBe(true));
  const before = await snapshot(fixture, host.sessionId);
  expect(JSON.stringify(before.rows.window)).toContain(
    "未读提交丢包后保持的用户正文",
  );
  expect(JSON.stringify(before.rows.window)).toContain(
    "未读提交丢包后保持的助手正文",
  );
  return before;
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Task 未读提交回包丢失的真实 HTTP 与 PostgreSQL integration",
  () => {
    it("真实提交后原观察重放返回同一标记，清除后旧回执不恢复标记且正文、修订和权限保持", async () => {
      let proxy: Proxy | undefined;
      const fixture = await createCodeUiHttpFixture({
        databaseTransport: async (direct) => {
          proxy = await createCommitResponseLossProxy(direct);
          return proxy;
        },
      });
      let host: Host | undefined;
      let model: Model | undefined;
      const failures: unknown[] = [];
      try {
        if (!proxy) throw new Error("未读回包验收没有建立独占 PG 代理。");
        model = await heldModel();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const before = await publishTask(fixture, host, model);
        const scopeBefore = await readScope(host);
        const initial = await readMeta(host);
        const intent = unreadIntent(initial, true);
        const key = JSON.stringify([
          fixture.actor.instanceId,
          intent.taskId,
          intent.taskControl.projectId,
          intent.taskControl.branchGeneration,
          intent.observedLastUnreadAt,
          true,
        ]);
        proxy.arm(key, { taskUnread: true });
        const unavailable = await changeUnread(host, intent);
        expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(500);
        expect(
          applicationErrorResponseSchema.parse(unavailable.body).error.code,
        ).toBe("code_ui_error");
        expect(proxy.evidence()).toMatchObject({
          injected: {
            commandId: key,
            taskUnread: true,
            targetTaskId: host.sessionId,
            commitConfirmed: true,
            replySuppressed: true,
          },
        });
        expect(proxy.evidence().observerError).toBeUndefined();
        proxy.restore();

        const committed = await readMeta(host);
        const marker = z
          .number()
          .int()
          .positive()
          .safe()
          .parse(committed.unreadAt);
        expect(marker).toBeGreaterThan(initial.lastUnreadAt);
        expect(committed.lastUnreadAt).toBe(marker);
        expect(proxy.evidence()).toMatchObject({
          injected: { targetUnreadAt: marker, targetLastUnreadAt: marker },
        });
        await expectCurrentMarker(host, committed);
        expect(await acceptedUnread(host, intent)).toEqual(committed);
        await expectCurrentMarker(host, committed);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);

        const cleared = await acceptedUnread(
          host,
          unreadIntent(committed, false),
        );
        expect(cleared.unreadAt).toBeUndefined();
        expect(cleared.lastUnreadAt).toBe(marker);
        expect(await acceptedUnread(host, intent)).toEqual(committed);
        await expectCurrentMarker(host, cleared);

        const next = await acceptedUnread(host, unreadIntent(cleared, true));
        expect(next.unreadAt).toBeGreaterThan(marker);
        expect(next.lastUnreadAt).toBe(next.unreadAt);
        expect(await acceptedUnread(host, intent)).toEqual(committed);
        await expectCurrentMarker(host, next);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);
        expect(model.requests).toHaveLength(1);
        expect(proxy.evidence().observerError).toBeUndefined();
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => host?.dispose(),
          () => model?.close(),
          () => fixture.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "未读提交回包验收或资源关闭失败", {
          cause: failures[0],
        });
    }, 90_000); // 本例独占 HTTP、SSE、模型流、PG 提交丢包和资源关闭期限。
  },
);
