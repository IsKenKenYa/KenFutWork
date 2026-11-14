import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodeTaskOrganizationTarget,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { createCommitResponseLossProxy } from "./pg-commit-response-loss.fixture.mjs";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type Proxy = Awaited<ReturnType<typeof createCommitResponseLossProxy>>;
type Scope = ReturnType<typeof codeTaskScopeResponseSchema.parse>["scope"];

function taskRpc(
  host: Host,
  method: "archiveTask" | "unarchiveTask",
  target: CodeTaskOrganizationTarget,
) {
  return host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method,
    args: [target],
  });
}

function observedTarget(
  host: Host,
  current: protocol.ConversationSnapshot,
): CodeTaskOrganizationTarget {
  if (!current.taskControl)
    throw new Error("归档回执丢包验证缺少公开Task观察值。");
  return {
    taskId: host.sessionId,
    workspacePath: host.workspacePath,
    workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
    taskControl: structuredClone(current.taskControl),
  };
}

async function taskScope(host: Host) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function prepareScope(fixture: Fixture, host: Host) {
  const selected = join(fixture.directory, "归档丢包保留的只读资料");
  await mkdir(selected);
  const path = await realpath(selected);
  const changed = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
    {
      additionalDirectories: [{ path, access: "read-only" }],
      sandboxMode: "workspace-write",
    },
    "PATCH",
  );
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  const before = await taskScope(host);
  expect(before).toMatchObject({
    taskId: host.sessionId,
    projectId: host.projectId,
    rootDirectory: host.workspacePath,
    additionalDirectories: [{ path, access: "read-only" }],
    sandboxMode: "workspace-write",
  });
  return before;
}

async function createArchiveCommitFixture() {
  let proxy: Proxy | undefined;
  const fixture = await createCodeUiHttpFixture({
    databaseTransport: async (direct) => {
      proxy = await createCommitResponseLossProxy(direct);
      return proxy;
    },
  });
  if (!proxy) {
    await fixture.close();
    throw new Error("归档完成测试未建立真实PG故障代理。");
  }
  return { fixture, proxy };
}

function archiveOperationKey(
  target: CodeTaskOrganizationTarget,
  archived: boolean,
) {
  return JSON.stringify([
    target.taskId,
    target.taskControl.projectId,
    target.taskControl.branchGeneration,
    archived,
  ]);
}

function expectCompletionReplySuppressed(
  proxy: Proxy,
  key: string,
  target: CodeTaskOrganizationTarget,
  archived: boolean,
) {
  expect(proxy.evidence()).toMatchObject({
    injected: {
      commandId: key,
      taskArchiveCompletion: true,
      targetTaskId: target.taskId,
      targetArchived: archived,
      commitConfirmed: true,
      replySuppressed: true,
    },
  });
  expect(proxy.evidence().observerError).toBeUndefined();
}

function expectStoppedTranscript(
  current: protocol.ConversationSnapshot,
  body: string,
) {
  expect(current.control.phase).toBe("completedInterrupted");
  expect(current.control.activeWorks).toEqual([]);
  expect(JSON.stringify(current.rows.window)).toContain(body);
  expect(JSON.stringify(current.rows.window)).toContain(
    "归档准备提交丢失回包后保留的原始输入",
  );
}

async function expectReplayedResult(
  host: Host,
  method: "archiveTask" | "unarchiveTask",
  target: CodeTaskOrganizationTarget,
) {
  const committed = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "getTaskMeta",
    args: [
      {
        taskId: target.taskId,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      },
    ],
  });
  expect(committed.status, JSON.stringify(committed.body)).toBe(200);
  expect(committed.body.result).toMatchObject({
    taskId: target.taskId,
    projectId: target.taskControl.projectId,
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
  });
  const replayed = await taskRpc(host, method, target);
  expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
  expect(replayed.body.result).toEqual(committed.body.result);
  const repeated = await taskRpc(host, method, target);
  expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
  expect(repeated.body.result).toEqual(replayed.body.result);
}

async function expectRoundTripScope(host: Host, before: Scope) {
  const after = await taskScope(host);
  // 一次真实归档和一次恢复各推进一个代际；回执重放不能增加代际。
  expect(after).toEqual({ ...before, generation: before.generation + 2 });
  return after;
}

async function prepareStoppedTask(fixture: Fixture, host: Host, model: Model) {
  const accepted = await host.command("sendText", {
    text: "归档准备提交丢失回包后保留的原始输入",
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(accepted.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  }); // 仅等待本例真实HTTP模型流，不属于运行时治理值。
  const body = "归档准备回包丢失前的助手正文";
  model.writeText(0, body);
  await vi.waitFor(
    async () => {
      const current = await snapshot(fixture, host.sessionId);
      expect(JSON.stringify(current.rows.window)).toContain(body);
    },
    { timeout: 30_000 },
  );
  const stoppedResponse = await host.command("stop", {});
  expect(stoppedResponse.status, JSON.stringify(stoppedResponse.body)).toBe(
    200,
  );
  expect(
    protocol.commandAckSchema.parse(stoppedResponse.body.result).status,
  ).toBe("accepted");
  const stopped = await waitPhase(
    fixture,
    host.sessionId,
    "completedInterrupted",
  );
  expect(JSON.stringify(stopped.rows.window)).toContain(body);
  await vi.waitFor(() => expect(model.requests[0]?.closed).toBe(true));
  if (!stopped.taskControl)
    throw new Error("归档准备丢包夹具缺少已停止Task的公开观察值。");
  const target: CodeTaskOrganizationTarget = {
    taskId: host.sessionId,
    workspacePath: host.workspacePath,
    workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
    taskControl: structuredClone(stopped.taskControl),
  };
  return { target, body };
}

async function expectArchivedTask(host: Host) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [
      { hostId: "local", includeDeleted: false, includeDeletedTasks: true },
    ],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const matching = codeProjectTreeSchema
    .parse(response.body.result)
    .tasks.filter((task) => task.taskId === host.sessionId);
  expect(matching).toEqual([
    expect.objectContaining({
      taskId: host.sessionId,
      projectId: host.projectId,
      workspacePath: host.workspacePath,
      workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
      archived: true,
    }),
  ]);
  const unavailable = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(
    unavailable.status,
    JSON.stringify(unavailable.body),
  ).toBeGreaterThanOrEqual(400);
  expect(unavailable.status).toBeLessThan(500);
  expect(codeTaskScopeResponseSchema.safeParse(unavailable.body).success).toBe(
    false,
  );
}

async function closeFixture(fixture: Fixture, model: Model, host?: Host) {
  const failures: unknown[] = [];
  for (const close of [
    () => host?.dispose(),
    () => model.close(),
    () => fixture.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "归档准备丢包夹具未全部关闭。");
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原Task归档及恢复COMMIT回包丢失的真实PG integration",
  () => {
    it("准备事务确已提交但回包丢失后，同归档目标重放继续关闭并保留身份正文", async () => {
      let proxy: Proxy | undefined;
      const fixture = await createCodeUiHttpFixture({
        databaseTransport: async (direct) => {
          proxy = await createCommitResponseLossProxy(direct);
          return proxy;
        },
      });
      const model = await heldModel();
      let host: Host | undefined;
      try {
        if (!proxy) throw new Error("归档准备测试未建立真实PG故障代理。");
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const { target, body } = await prepareStoppedTask(fixture, host, model);
        const key = JSON.stringify([
          target.taskId,
          target.taskControl.projectId,
          target.taskControl.branchGeneration,
          true,
        ]);
        const client = host.client;
        const archive = () =>
          client.request("/api/code-ui/rpc", {
            service: "zcode-task",
            method: "archiveTask",
            args: [target],
          });
        proxy.arm(key, { taskArchivePrepare: true });
        const unavailable = await archive();
        expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(500);
        expect(unavailable.body.error.code).toBe("code_ui_error");
        expect(proxy.evidence()).toMatchObject({
          injected: {
            commandId: key,
            taskArchivePrepare: true,
            targetTaskId: target.taskId,
            commitConfirmed: true,
            replySuppressed: true,
          },
        });
        expect(proxy.evidence().observerError).toBeUndefined();
        proxy.restore();
        const replayed = await archive();
        expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
        expect(replayed.body.result).toMatchObject({
          taskId: target.taskId,
          projectId: target.taskControl.projectId,
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
        });
        await expectArchivedTask(host);
        const retained = await snapshot(fixture, target.taskId);
        expect(retained.control.phase).toBe("completedInterrupted");
        expect(retained.control.activeWorks).toEqual([]);
        expect(JSON.stringify(retained.rows.window)).toContain(body);
        expect(model.requests).toHaveLength(1);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000);

    it("归档完成COMMIT回包丢失后同目标返回原持久结果，重放不再次推进授权与分支", async () => {
      const { fixture, proxy } = await createArchiveCommitFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const before = await prepareScope(fixture, host);
        const { target, body } = await prepareStoppedTask(fixture, host, model);
        const key = archiveOperationKey(target, true);
        proxy.arm(key, { taskArchiveCompletion: true });
        const unavailable = await taskRpc(host, "archiveTask", target);
        expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(500);
        expect(unavailable.body.error.code).toBe("code_ui_error");
        expectCompletionReplySuppressed(proxy, key, target, true);
        proxy.restore();
        await expectArchivedTask(host);
        const committed = await snapshot(fixture, target.taskId);
        expectStoppedTranscript(committed, body);
        expect(committed.taskControl).toEqual({
          ...target.taskControl,
          branchGeneration: target.taskControl.branchGeneration + 1,
        });
        await expectReplayedResult(host, "archiveTask", target);
        await expectArchivedTask(host);
        const replayed = await snapshot(fixture, target.taskId);
        expect(replayed.taskControl).toEqual(committed.taskControl);
        expectStoppedTranscript(replayed, body);
        expect(model.requests).toHaveLength(1);
        // 归档期间不开放Scope；一次合法恢复后通过公开Scope核对完整权限和精确代际。
        const restored = await taskRpc(
          host,
          "unarchiveTask",
          observedTarget(host, replayed),
        );
        expect(restored.status, JSON.stringify(restored.body)).toBe(200);
        await expectRoundTripScope(host, before);
        const opened = await snapshot(fixture, target.taskId);
        expect(opened.taskControl).toEqual({
          ...target.taskControl,
          branchGeneration: target.taskControl.branchGeneration + 2,
        });
        expectStoppedTranscript(opened, body);
        expect(model.requests).toHaveLength(1);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000);

    it("恢复原子COMMIT回包丢失后同目标返回原结果，重放保持已恢复Scope、分支及正文", async () => {
      const { fixture, proxy } = await createArchiveCommitFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const before = await prepareScope(fixture, host);
        const stopped = await prepareStoppedTask(fixture, host, model);
        const archived = await taskRpc(host, "archiveTask", stopped.target);
        expect(archived.status, JSON.stringify(archived.body)).toBe(200);
        await expectArchivedTask(host);
        const closed = await snapshot(fixture, host.sessionId);
        const target = observedTarget(host, closed);
        expect(target.taskControl.branchGeneration).toBe(
          stopped.target.taskControl.branchGeneration + 1,
        );
        const key = archiveOperationKey(target, false);
        proxy.arm(key, { taskArchiveCompletion: true });
        const unavailable = await taskRpc(host, "unarchiveTask", target);
        expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(500);
        expect(unavailable.body.error.code).toBe("code_ui_error");
        expectCompletionReplySuppressed(proxy, key, target, false);
        proxy.restore();
        const committedScope = await expectRoundTripScope(host, before);
        const committed = await snapshot(fixture, target.taskId);
        expect(committed.taskControl).toEqual({
          ...target.taskControl,
          branchGeneration: target.taskControl.branchGeneration + 1,
        });
        expectStoppedTranscript(committed, stopped.body);
        await expectReplayedResult(host, "unarchiveTask", target);
        expect(await taskScope(host)).toEqual(committedScope);
        const replayed = await snapshot(fixture, target.taskId);
        expect(replayed.taskControl).toEqual(committed.taskControl);
        expectStoppedTranscript(replayed, stopped.body);
        expect(model.requests).toHaveLength(1);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000);
  },
);
