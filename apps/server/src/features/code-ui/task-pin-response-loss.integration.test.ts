import {
  applicationErrorResponseSchema,
  type CodeTaskPinInput,
  codeProjectTreeSchema,
  codeTaskPinMetaSchema,
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
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
type TaskMeta = z.infer<typeof codeTaskPinMetaSchema>;

function pinIntent(meta: TaskMeta, pinned: boolean): CodeTaskPinInput {
  if (!meta.workspaceIdentity)
    throw new Error("置顶回包验收缺少公开 Task 工作域身份。");
  return {
    taskId: meta.taskId,
    workspacePath: meta.workspacePath,
    workspaceIdentity: meta.workspaceIdentity,
    taskControl: structuredClone(meta.taskControl),
    observedPinRevision: meta.pinRevision,
    pinned,
  };
}

async function readMeta(host: Host) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "getTaskMeta",
    args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskPinMetaSchema.parse(response.body.result);
}

async function changePin(
  host: Host,
  input: CodeTaskPinInput,
  controller = false,
) {
  const { pinned, ...address } = input;
  return host.client.request("/api/code-ui/rpc", {
    service: controller ? "window-controller" : "zcode-task",
    method: controller ? "mutateTask" : "setTaskPinned",
    args: [controller ? { address, mutation: { kind: "pin", pinned } } : input],
  });
}

async function acceptedPin(
  host: Host,
  input: CodeTaskPinInput,
  controller = false,
) {
  const response = await changePin(host, input, controller);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskPinMetaSchema.parse(response.body.result);
}

async function expectReplay(
  host: Host,
  input: CodeTaskPinInput,
  result: TaskMeta,
) {
  for (const controller of [false, true])
    expect(await acceptedPin(host, input, controller)).toEqual(result);
}

async function expectCurrentPin(host: Host, meta: TaskMeta) {
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
  if (!task) throw new Error("公开项目树缺少置顶回包验收 Task。");
  expect(task).toMatchObject({
    pinned: meta.pinned,
    pinRevision: meta.pinRevision,
    updatedAt: meta.updatedAt,
    taskControl: meta.taskControl,
  });
  const ids = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "listPinnedTaskIds",
    args: [{ workspacePath: host.workspacePath }],
  });
  expect(ids.status, JSON.stringify(ids.body)).toBe(200);
  expect(
    z.array(z.uuid()).parse(ids.body.result).includes(host.sessionId),
  ).toBe(meta.pinned);
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
    text: "置顶提交丢包后保持的用户正文",
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(response.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  }); // 只等待本例真实本机模型 HTTP 请求，不属于产品治理值。
  model.writeText(0, "置顶提交丢包后保持的助手正文");
  model.finish(0);
  await waitPhase(fixture, host.sessionId, "completedSuccess");
  await vi.waitFor(() => expect(model.requests[0]?.closed).toBe(true));
  const before = await snapshot(fixture, host.sessionId);
  expect(JSON.stringify(before.rows.window)).toContain(
    "置顶提交丢包后保持的用户正文",
  );
  expect(JSON.stringify(before.rows.window)).toContain(
    "置顶提交丢包后保持的助手正文",
  );
  return before;
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Task 置顶提交回包丢失的真实 HTTP 与 PostgreSQL integration",
  () => {
    it("真实提交后两入口重放同一置顶修订，旧回执不覆盖取消与再次置顶且正文和权限保持", async () => {
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
        if (!proxy) throw new Error("置顶回包验收没有建立独占 PG 代理。");
        model = await heldModel();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const before = await publishTask(fixture, host, model);
        const scopeBefore = await readScope(host);
        const initial = await readMeta(host);
        expect(initial).toMatchObject({ pinned: false, pinRevision: 0 });
        const intent = pinIntent(initial, true);
        const key = JSON.stringify([
          fixture.actor.instanceId,
          intent.taskId,
          intent.taskControl.projectId,
          intent.taskControl.branchGeneration,
          intent.observedPinRevision,
          intent.pinned,
        ]);
        proxy.arm(key, { taskPin: true });
        const unavailable = await changePin(host, intent);
        expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(500);
        expect(
          applicationErrorResponseSchema.parse(unavailable.body).error.code,
        ).toBe("code_ui_error");
        expect(proxy.evidence()).toMatchObject({
          injected: {
            commandId: key,
            taskPin: true,
            targetTaskId: host.sessionId,
            targetPinned: true,
            targetPinRevision: initial.pinRevision + 1,
            commitConfirmed: true,
            replySuppressed: true,
          },
        });
        expect(proxy.evidence().observerError).toBeUndefined();
        proxy.restore();

        const committed = await readMeta(host);
        expect(committed).toMatchObject({
          pinned: true,
          pinRevision: initial.pinRevision + 1,
          updatedAt: initial.updatedAt,
        });
        await expectReplay(host, intent, committed);
        await expectCurrentPin(host, committed);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);

        const cancel = pinIntent(committed, false);
        const cleared = await acceptedPin(host, cancel, true);
        expect(cleared).toMatchObject({
          pinned: false,
          pinRevision: committed.pinRevision + 1,
          updatedAt: initial.updatedAt,
        });
        await expectReplay(host, intent, committed);
        await expectCurrentPin(host, cleared);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);

        const next = await acceptedPin(host, pinIntent(cleared, true));
        expect(next).toMatchObject({
          pinned: true,
          pinRevision: cleared.pinRevision + 1,
          updatedAt: initial.updatedAt,
        });
        await expectReplay(host, cancel, cleared);
        await expectReplay(host, intent, committed);
        await expectCurrentPin(host, next);
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
        throw new AggregateError(failures, "置顶提交回包验收或资源关闭失败", {
          cause: failures[0],
        });
    }, 90_000); // 本例独占 HTTP、SSE、模型流、PG 提交丢包和资源关闭期限。
  },
);
