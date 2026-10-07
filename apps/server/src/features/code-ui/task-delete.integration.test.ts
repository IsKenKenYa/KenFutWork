import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codeUiWorkspaceSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type TaskTarget = {
  taskId: string;
  projectId: string;
  workspacePath: string;
  workspaceIdentity?: string;
};
const taskListSchema = z.array(z.object({ taskId: z.string() }));

function rootTarget(host: Host): TaskTarget & { workspaceIdentity: string } {
  return {
    taskId: host.sessionId,
    projectId: host.projectId,
    workspacePath: host.workspacePath,
    workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
  };
}

function taskRpc(host: Host, method: string, target: TaskTarget) {
  return host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method,
    args: [target],
  });
}

async function listedTaskIds(host: Host, target: TaskTarget) {
  const response = await taskRpc(host, "listTasks", target);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return taskListSchema.parse(response.body.result).map((task) => task.taskId);
}

async function deletedTaskIds(host: Host, target: TaskTarget) {
  const response = await taskRpc(host, "listDeletedTaskIds", target);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return z.array(z.string()).parse(response.body.result);
}

function send(host: Host, target: TaskTarget, text: string) {
  return host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: target.workspacePath,
      projectId: target.projectId,
      workspaceIdentity: target.workspaceIdentity,
      envelope: {
        type: "sendText",
        sessionId: target.taskId,
        clientId: host.clientId,
        commandId: randomUUID(),
        payload: { text },
        issuedAt: Date.now(),
      },
    },
  ]);
}

async function createAdjacentTask(
  fixture: Fixture,
  host: Host,
  workspace: Pick<TaskTarget, "projectId" | "workspacePath"> = rootTarget(host),
): Promise<TaskTarget & { workspaceIdentity: string }> {
  const current = await snapshot(fixture, host.sessionId);
  if (!current.config.modelSelection)
    throw new Error("真实删除夹具缺少可执行模型选择。");
  const response = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: workspace.workspacePath,
      projectId: workspace.projectId,
      envelope: {
        type: "createSession",
        sessionId: null,
        clientId: host.clientId,
        commandId: randomUUID(),
        payload: {
          workspaceId: workspace.projectId,
          config: {
            modelSelection: current.config.modelSelection,
            mode: "build",
            planEnabled: false,
          },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(response.body.result);
  expect(ack.status).toBe("accepted");
  if (ack.result?.type !== "createSession")
    throw new Error("原创建命令未返回邻居Task身份。");
  return {
    ...workspace,
    taskId: ack.result.sessionId,
    workspaceIdentity: JSON.stringify([
      workspace.projectId,
      workspace.workspacePath,
    ]),
  };
}

async function finishInput(
  fixture: Fixture,
  host: Host,
  model: Model,
  target: TaskTarget,
  text: string,
) {
  const index = model.requests.length;
  const accepted = await send(host, target, text);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(accepted.body.result.status).toBe("accepted");
  await vi.waitFor(() => expect(model.requests).toHaveLength(index + 1), {
    timeout: 30_000,
  });
  model.finish(index);
  await waitPhase(fixture, target.taskId, "completedSuccess");
}

async function prepareDeletionNeighbors(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const target = rootTarget(host);
  const marker = join(host.workspacePath, "delete-native.txt");
  await writeFile(marker, "DELETE_NATIVE_REAL_READ_SENTINEL");
  await host.command("sendText", { text: "DELETE_ORIGINAL_INPUT" });
  await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
    timeout: 30_000,
  });
  expect(JSON.stringify(model.requests[1]?.body.messages)).toContain(
    "DELETE_NATIVE_REAL_READ_SENTINEL",
  );
  model.finish(1);
  await waitPhase(fixture, target.taskId, "completedSuccess");
  const neighbor = await createAdjacentTask(fixture, host);
  await finishInput(fixture, host, model, neighbor, "DELETE_NEIGHBOR");
  const otherDirectory = join(fixture.directory, "delete-other-project");
  await mkdir(otherDirectory);
  const opened = await host.client.request("/api/code-ui/rpc", {
    service: "workspace",
    method: "open",
    args: [{ path: otherDirectory }],
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const otherWorkspace = codeUiWorkspaceSchema.parse(opened.body.result);
  expect(otherWorkspace.projectId).not.toBe(target.projectId);
  const other = await createAdjacentTask(fixture, host, {
    projectId: otherWorkspace.projectId,
    workspacePath: otherWorkspace.path,
  });
  await finishInput(fixture, host, model, other, "DELETE_OTHER_PROJECT");
  return { target, neighbor, other, marker };
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
    throw new AggregateError(failures, "真实删除夹具未全部关闭。");
}

async function assertDeleted(
  fixture: Fixture,
  host: Host,
  target: TaskTarget,
  neighbor: TaskTarget,
) {
  const absent = await fixture.client.request(
    `/api/code-ui/sessions/${target.taskId}`,
  );
  expect(absent.status, JSON.stringify(absent.body)).toBe(404);
  const scope = await fixture.client.request(
    `/api/code-ui/tasks/${target.taskId}/scope`,
  );
  expect(scope.status, JSON.stringify(scope.body)).toBe(404);
  expect(await listedTaskIds(host, target)).not.toContain(target.taskId);
  expect(await listedTaskIds(host, target)).toContain(neighbor.taskId);
  expect(await deletedTaskIds(host, target)).toContain(target.taskId);
  expect(await deletedTaskIds(host, target)).not.toContain(neighbor.taskId);
}

describe.skipIf(!enabled)("原Task删除公开RPC integration", () => {
  it("错误固定目录、qualified identity与其他Project均拒绝；正确删除不可见且保留原生历史和邻居", async () => {
    const fixture = await createCodeUiHttpFixture();
    const model = await heldModel({
      initialTool: {
        id: "delete-real-read",
        name: "Read",
        arguments: { file_path: "delete-native.txt" },
      },
    });
    let host: Host | undefined;
    try {
      host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      const { target, neighbor, other, marker } =
        await prepareDeletionNeighbors(fixture, host, model);
      for (const wrong of [
        { ...target, workspacePath: other.workspacePath },
        { ...target, workspaceIdentity: other.workspaceIdentity },
        { ...target, projectId: other.projectId },
        { ...other, workspacePath: target.workspacePath },
      ]) {
        const refused = await taskRpc(host, "deleteTask", wrong);
        expect(refused.status, JSON.stringify(refused.body)).toBe(404);
        expect(refused.body.error.code).toBe("code_ui_not_found");
        for (const owned of [target, neighbor, other])
          expect((await snapshot(fixture, owned.taskId)).control.phase).toBe(
            "completedSuccess",
          );
      }
      expect(await listedTaskIds(host, target)).toEqual(
        expect.arrayContaining([target.taskId, neighbor.taskId]),
      );
      expect(await listedTaskIds(host, other)).toContain(other.taskId);
      const binding = await fixture.app.kernel
        .get("threads")
        .resolveOwnedSessionThread(fixture.actor, target.taskId);
      const native = await fixture.app.kernel
        .get("agentPersistence")
        .getPersistence();
      if (!native) throw new Error("真实删除夹具未装配持久native。");
      const config = {
        configurable: { thread_id: binding.threadId, checkpoint_ns: "" },
      };
      const before = await native.checkpointer.getTuple(config);
      if (!before) throw new Error("实际Read执行后未保存native历史。");
      const removed = await taskRpc(host, "deleteTask", target);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(removed.body.result).toBeNull();
      await assertDeleted(fixture, host, target, neighbor);
      expect((await snapshot(fixture, other.taskId)).control.phase).toBe(
        "completedSuccess",
      );
      const retained = await native.checkpointer.getTuple(config);
      expect(retained?.checkpoint.id).toBe(before.checkpoint.id);
      expect(await readFile(marker, "utf8")).toBe(
        "DELETE_NATIVE_REAL_READ_SENTINEL",
      );
    } finally {
      await closeFixture(fixture, model, host);
    }
  }, 90_000);

  it("并发删除只关闭所属活动Run；顺序重复与迟到发送拒绝且墓碑不复活，邻居继续", async () => {
    const fixture = await createCodeUiHttpFixture();
    const model = await heldModel();
    let host: Host | undefined;
    try {
      host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      const target = rootTarget(host);
      await host.command("sendText", { text: "DELETE_ACTIVE_SOURCE" });
      await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
        timeout: 30_000,
      });
      await waitPhase(fixture, target.taskId, "running");
      const neighbor = await createAdjacentTask(fixture, host);
      expect(
        (await send(host, neighbor, "DELETE_ACTIVE_NEIGHBOR")).body.result
          .status,
      ).toBe("accepted");
      await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
        timeout: 30_000,
      });
      const neighborRunning = await waitPhase(
        fixture,
        neighbor.taskId,
        "running",
      );
      const foreground = neighborRunning.control.activeWorks.find(
        (work) => work.kind === "primaryTurn",
      )?.foregroundExecutionId;
      if (!foreground) throw new Error("邻居没有真实前台Run身份。");
      const results = await Promise.all([
        taskRpc(host, "deleteTask", target),
        taskRpc(host, "deleteTask", target),
      ]);
      expect(results.filter((result) => result.status === 200)).toHaveLength(1);
      for (const result of results) {
        if (result.status === 200) expect(result.body.result).toBeNull();
        else {
          expect([404, 409]).toContain(result.status);
          expect(result.body.error.code).toBe(
            result.status === 404
              ? "code_ui_not_found"
              : "code_ui_revision_conflict",
          );
        }
      }
      await vi.waitFor(() => expect(model.requests[0]?.closed).toBe(true));
      expect(model.requests[1]?.closed).toBe(false);
      await assertDeleted(fixture, host, target, neighbor);
      expect(
        (await snapshot(fixture, neighbor.taskId)).control.activeWorks,
      ).toContainEqual(
        expect.objectContaining({ foregroundExecutionId: foreground }),
      );
      // 目前已删除Task的重复原RPC返回404；不伪装成原ZCode的void成功回执。
      const repeated = await taskRpc(host, "deleteTask", target);
      expect(repeated.status, JSON.stringify(repeated.body)).toBe(404);
      expect(repeated.body.error.code).toBe("code_ui_not_found");
      const late = await send(host, target, "DELETE_LATE_INPUT_MUST_NOT_RUN");
      expect(late.status, JSON.stringify(late.body)).toBe(404);
      expect(late.body.error.code).toBe("code_ui_not_found");
      expect(model.requests).toHaveLength(2);
      model.finish(1);
      await waitPhase(fixture, neighbor.taskId, "completedSuccess");
      await assertDeleted(fixture, host, target, neighbor);
      expect(await deletedTaskIds(host, target)).toEqual([target.taskId]);
      expect(model.requests).toHaveLength(2);
    } finally {
      await closeFixture(fixture, model, host);
    }
  }, 90_000);
});
