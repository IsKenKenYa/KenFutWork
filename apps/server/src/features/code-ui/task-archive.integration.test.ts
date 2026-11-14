import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  codeGoalControlStateSchema,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { snapshot, waitPhase } from "./history-fork.fixture.js";
import { nextHostServiceEvent } from "./host-client.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type ArchiveTarget = {
  taskId: string;
  workspacePath: string;
  workspaceIdentity: string;
  taskControl: protocol.ConversationTaskControl;
};

function taskRpc(host: Host, method: string, target: ArchiveTarget) {
  return host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method,
    args: [target],
  });
}

async function taskScope(host: Host) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function treeTask(host: Host) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [
      { hostId: "local", includeDeleted: false, includeDeletedTasks: true },
    ],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const task = codeProjectTreeSchema
    .parse(response.body.result)
    .tasks.find((item) => item.taskId === host.sessionId);
  if (!task) throw new Error("公开项目树缺少本例已发表的根Task。");
  return task;
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
    throw new AggregateError(failures, "真实归档夹具未全部关闭。");
}

function observedArchiveTarget(
  host: Host,
  current: protocol.ConversationSnapshot,
): ArchiveTarget {
  if (!current.taskControl) throw new Error("真实归档操作缺少公开Task观察值。");
  return {
    taskId: host.sessionId,
    workspacePath: host.workspacePath,
    workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
    taskControl: structuredClone(current.taskControl),
  };
}

async function stopTaskWithPublicBody(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const accepted = await host.command("sendText", {
    text: "并发恢复保留的原始输入",
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(accepted.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  }); // 仅等待本例真实HTTP模型流，不属于运行时治理值。
  const body = "并发恢复前已经输出的助手正文";
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
  expect(stopped.goal).toBeNull();
  await vi.waitFor(() => expect(model.requests[0]?.closed).toBe(true));
  return { stopped, body };
}

async function expectTaskAbsent(host: Host) {
  for (const path of [
    `/api/code-ui/sessions/${host.sessionId}`,
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  ]) {
    const response = await host.client.request(path);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
  }
}

async function prepareReadonlyDirectory(fixture: Fixture, host: Host) {
  const additional = join(fixture.directory, "归档保留的只读目录 ");
  await mkdir(additional);
  const changed = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
    {
      additionalDirectories: [{ path: additional, access: "read-only" }],
      sandboxMode: "workspace-write",
    },
    "PATCH",
  );
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  return additional;
}

async function startPublicGoal(host: Host, objective: string) {
  const initial = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  expect(initial.goal).toBeNull();
  if (!initial.taskControl) throw new Error("真实归档夹具缺少公开Task观察值。");
  const accepted = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
      projectId: host.projectId,
      goalControl: { expectedGoal: null },
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: host.sessionId,
        type: "sendGoalCommand",
        payload: { text: objective },
        taskControl: initial.taskControl,
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(accepted.body.result).status).toBe(
    "accepted",
  );
}

async function pauseGoalWithPublicBody(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const objective = "归档与恢复保留的暂停目标";
  await startPublicGoal(host, objective);
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  }); // 仅等待本例真实HTTP模型流，不属于运行时治理值。
  const body = "归档前已经输出的助手正文";
  const taskId = host.sessionId;
  model.writeText(0, body);
  await vi.waitFor(
    async () => {
      const current = await snapshot(fixture, taskId);
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
  expect(stopped.goal).toMatchObject({ objective, status: "paused" });
  expect(JSON.stringify(stopped.rows.window)).toContain(body);
  await vi.waitFor(() => expect(model.requests[0]?.closed).toBe(true));
  return { stopped, body };
}

async function preparePausedGoal(fixture: Fixture, host: Host, model: Model) {
  const additional = await prepareReadonlyDirectory(fixture, host);
  const { stopped, body } = await pauseGoalWithPublicBody(fixture, host, model);
  const before = await taskScope(host);
  expect(before).toMatchObject({
    projectId: host.projectId,
    taskId: host.sessionId,
    rootDirectory: host.workspacePath,
    additionalDirectories: [
      { path: await realpath(additional), access: "read-only" },
    ],
    sandboxMode: "workspace-write",
  });
  expect(await treeTask(host)).toMatchObject({
    taskId: host.sessionId,
    archived: false,
  });
  if (!stopped.taskControl)
    throw new Error("已停止根Task缺少归档前公开观察值。");
  const archiveTarget = observedArchiveTarget(host, stopped);
  return { stopped, body, before, archiveTarget };
}

type PausedGoalPreparation = Awaited<ReturnType<typeof preparePausedGoal>>;

async function archiveAndObservePausedGoal(
  fixture: Fixture,
  host: Host,
  prepared: PausedGoalPreparation,
) {
  const { stopped, body, archiveTarget } = prepared;
  const archived = await taskRpc(host, "archiveTask", archiveTarget);
  expect(archived.status, JSON.stringify(archived.body)).toBe(200);
  expect(archived.body.result).toMatchObject({
    taskId: host.sessionId,
    workspacePath: host.workspacePath,
    projectId: host.projectId,
  });
  expect(await treeTask(host)).toMatchObject({
    taskId: host.sessionId,
    archived: true,
  });
  const unavailable = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(
    unavailable.status,
    JSON.stringify(unavailable.body),
  ).toBeGreaterThanOrEqual(400);
  expect(unavailable.status).toBeLessThan(500);
  z.object({
    error: z.object({ code: z.string().min(1), message: z.string().min(1) }),
  }).parse(unavailable.body);
  expect(codeTaskScopeResponseSchema.safeParse(unavailable.body).success).toBe(
    false,
  );
  const closed = await snapshot(fixture, host.sessionId);
  expect(closed.goal).toEqual(stopped.goal);
  expect(JSON.stringify(closed.rows.window)).toContain(body);
  if (!closed.taskControl)
    throw new Error("已归档根Task缺少恢复前公开观察值。");
  expect(closed.taskControl.branchGeneration).toBeGreaterThan(
    archiveTarget.taskControl.branchGeneration,
  );
  return { ...archiveTarget, taskControl: structuredClone(closed.taskControl) };
}

async function expectOrganizationParameterConflicts(
  fixture: Fixture,
  host: Host,
  method: "archiveTask" | "unarchiveTask",
  target: ArchiveTarget,
) {
  const before = await snapshot(fixture, host.sessionId);
  const scopePath = `/api/code-ui/tasks/${host.sessionId}/scope`;
  const scopeBefore = await host.client.request(scopePath);
  const taskBefore = await treeTask(host);
  const changedDirectory = join(target.workspacePath, "同业务键的另一目录");
  for (const changed of [
    { ...target, workspacePath: changedDirectory },
    {
      ...target,
      workspaceIdentity: JSON.stringify([
        target.taskControl.projectId,
        changedDirectory,
      ]),
    },
  ]) {
    const rejected = await taskRpc(host, method, changed);
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
    expect(await snapshot(fixture, host.sessionId)).toEqual(before);
    expect(await host.client.request(scopePath)).toEqual(scopeBefore);
    expect(await treeTask(host)).toEqual(taskBefore);
  }
}

async function restoreAndReplayPausedGoal(
  fixture: Fixture,
  host: Host,
  model: Model,
  prepared: PausedGoalPreparation,
  restoreTarget: ArchiveTarget,
) {
  const { stopped, body, before } = prepared;
  const restored = await taskRpc(host, "unarchiveTask", restoreTarget);
  expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  expect(restored.body.result).toMatchObject({
    taskId: host.sessionId,
    workspacePath: host.workspacePath,
    projectId: host.projectId,
  });
  expect(await treeTask(host)).toMatchObject({
    taskId: host.sessionId,
    archived: false,
  });
  const after = await taskScope(host);
  const { generation: beforeGeneration, ...permissionsBefore } = before;
  const { generation: restoredGeneration, ...permissionsAfter } = after;
  expect(permissionsAfter).toEqual(permissionsBefore);
  expect(restoredGeneration).toBeGreaterThan(beforeGeneration);
  const afterSnapshot = await snapshot(fixture, host.sessionId);
  if (!afterSnapshot.taskControl)
    throw new Error("已恢复根Task缺少公开Task观察值。");
  expect(afterSnapshot.taskControl.branchGeneration).toBeGreaterThan(
    restoreTarget.taskControl.branchGeneration,
  );
  expect(afterSnapshot.goal).toEqual(stopped.goal);
  expect(afterSnapshot.control.phase).toBe("completedInterrupted");
  expect(afterSnapshot.control.activeWorks).toEqual([]);
  expect(JSON.stringify(afterSnapshot.rows.window)).toContain(body);
  expect(model.requests).toHaveLength(1);
  await expectOrganizationParameterConflicts(
    fixture,
    host,
    "unarchiveTask",
    restoreTarget,
  );
  const repeated = await taskRpc(host, "unarchiveTask", restoreTarget);
  expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
  expect(repeated.body.result).toEqual(restored.body.result);
  expect(await taskScope(host)).toEqual(after);
  expect(await treeTask(host)).toMatchObject({
    taskId: host.sessionId,
    archived: false,
  });
  const repeatedSnapshot = await snapshot(fixture, host.sessionId);
  expect(repeatedSnapshot.taskControl).toEqual(afterSnapshot.taskControl);
  expect(repeatedSnapshot.goal).toEqual(stopped.goal);
  expect(repeatedSnapshot.control.activeWorks).toEqual([]);
  expect(model.requests).toHaveLength(1);
}

async function resumeObservedGoal(
  host: Host,
  before: protocol.ConversationSnapshot,
) {
  const subscribed = await host.stream.rpc("subscribeConversationV4", [
    {
      sessionId: host.sessionId,
      workspacePath: host.workspacePath,
      projectId: host.projectId,
    },
  ]);
  expect(subscribed.status, JSON.stringify(subscribed.body)).toBe(200);
  const observed = codeGoalControlStateSchema.parse(
    (
      await nextHostServiceEvent(
        host.stream,
        "zcodeAgentService",
        "onGoalControlState",
        { taskId: host.sessionId },
      )
    ).data,
  );
  return host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      goalControl: { expectedGoal: observed.goal },
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: host.sessionId,
        type: "resumeGoal",
        payload: {},
        baseRevision: before.revision,
        taskControl: before.taskControl,
        issuedAt: Date.now(),
      },
    },
  ]);
}

async function resumeRestoredGoal(fixture: Fixture, host: Host, model: Model) {
  const before = await snapshot(fixture, host.sessionId);
  const resumed = await resumeObservedGoal(host, before);
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(resumed.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
    timeout: 30_000,
  });
  const running = await snapshot(fixture, host.sessionId);
  expect(running.goal).toMatchObject({
    targetId: before.goal?.targetId,
    objective: "归档与恢复保留的暂停目标",
    status: "active",
  });
  expect(running.taskControl).toEqual(before.taskControl);
  const stopped = await host.command("stop", {});
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(stopped.body.result).status).toBe(
    "accepted",
  );
  const paused = await waitPhase(
    fixture,
    host.sessionId,
    "completedInterrupted",
  );
  expect(paused.goal).toMatchObject({
    targetId: before.goal?.targetId,
    objective: "归档与恢复保留的暂停目标",
    status: "paused",
  });
  await vi.waitFor(() => expect(model.requests[1]?.closed).toBe(true));
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原Task归档与恢复的真实RPC及PostgreSQL integration",
  () => {
    it("归档已停止的根Task后关闭执行授权，恢复保留原目录权限与暂停Goal且同输入重放不再改变", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const prepared = await preparePausedGoal(fixture, host, model);
        const restoreTarget = await archiveAndObservePausedGoal(
          fixture,
          host,
          prepared,
        );
        await expectOrganizationParameterConflicts(
          fixture,
          host,
          "archiveTask",
          prepared.archiveTarget,
        );
        expect(model.requests).toHaveLength(1);
        await restoreAndReplayPausedGoal(
          fixture,
          host,
          model,
          prepared,
          restoreTarget,
        );
        await resumeRestoredGoal(fixture, host, model);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000);

    it("规划轮结束后归档与恢复保留暂停Goal，不自动继续运行", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "build", planEnabled: true },
        });
        await startPublicGoal(host, "归档不自动恢复规划目标");
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        model.finish(0);
        const idle = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        expect(idle.config.planEnabled).toBe(true);
        expect(idle.goal).toMatchObject({ status: "paused" });
        const archived = await taskRpc(
          host,
          "archiveTask",
          observedArchiveTarget(host, idle),
        );
        expect(archived.status, JSON.stringify(archived.body)).toBe(200);
        const closed = await snapshot(fixture, host.sessionId);
        expect(closed.goal).toMatchObject({
          targetId: idle.goal?.targetId,
          objective: "归档不自动恢复规划目标",
          status: "paused",
        });
        const restored = await taskRpc(
          host,
          "unarchiveTask",
          observedArchiveTarget(host, closed),
        );
        expect(restored.status, JSON.stringify(restored.body)).toBe(200);
        expect((await snapshot(fixture, host.sessionId)).goal).toEqual(
          closed.goal,
        );
        expect(model.requests).toHaveLength(1);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000);

    it("同一归档观察值并发恢复返回同一持久元信息且只恢复一次执行权限", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const { stopped, body } = await stopTaskWithPublicBody(
          fixture,
          host,
          model,
        );
        const before = await taskScope(host);
        const archiveTarget = observedArchiveTarget(host, stopped);
        const archived = await taskRpc(host, "archiveTask", archiveTarget);
        expect(archived.status, JSON.stringify(archived.body)).toBe(200);
        expect(await treeTask(host)).toMatchObject({
          taskId: host.sessionId,
          archived: true,
        });
        const closed = await snapshot(fixture, host.sessionId);
        const restoreTarget = observedArchiveTarget(host, closed);
        expect(restoreTarget.taskControl.branchGeneration).toBe(
          archiveTarget.taskControl.branchGeneration + 1,
        );
        const [first, second] = await Promise.all([
          taskRpc(host, "unarchiveTask", restoreTarget),
          taskRpc(host, "unarchiveTask", restoreTarget),
        ]);
        for (const response of [first, second]) {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(response.body.result).toMatchObject({
            taskId: host.sessionId,
            workspacePath: host.workspacePath,
            projectId: host.projectId,
          });
        }
        expect(second.body.result).toEqual(first.body.result);
        const after = await taskScope(host);
        // 一次归档与一次恢复各推进一个代际，并发恢复不能再次推进。
        expect(after).toEqual({ ...before, generation: before.generation + 2 });
        const restored = await snapshot(fixture, host.sessionId);
        expect(restored.taskControl).toEqual({
          ...restoreTarget.taskControl,
          branchGeneration: restoreTarget.taskControl.branchGeneration + 1,
        });
        expect(restored.control.phase).toBe("completedInterrupted");
        expect(restored.control.activeWorks).toEqual([]);
        expect(restored.goal).toBeNull();
        expect(JSON.stringify(restored.rows.window)).toContain(body);
        expect(await treeTask(host)).toMatchObject({
          taskId: host.sessionId,
          archived: false,
        });
        expect(model.requests).toHaveLength(1);
        const replayed = await taskRpc(host, "unarchiveTask", restoreTarget);
        expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
        expect(replayed.body.result).toEqual(first.body.result);
        expect(await taskScope(host)).toEqual(after);
        const replayedSnapshot = await snapshot(fixture, host.sessionId);
        expect(replayedSnapshot.taskControl).toEqual(restored.taskControl);
        expect(replayedSnapshot.goal).toBeNull();
        expect(replayedSnapshot.control.activeWorks).toEqual([]);
        expect(model.requests).toHaveLength(1);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000);

    it("条件删除拒绝已经恢复的归档观察值，仅删除当前仍归档的Task且重复返回false", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const { stopped, body } = await stopTaskWithPublicBody(
          fixture,
          host,
          model,
        );
        const archiveTarget = observedArchiveTarget(host, stopped);
        const archived = await taskRpc(host, "archiveTask", archiveTarget);
        expect(archived.status, JSON.stringify(archived.body)).toBe(200);
        expect(await treeTask(host)).toMatchObject({ archived: true });
        const firstArchive = await snapshot(fixture, host.sessionId);
        const staleTarget = observedArchiveTarget(host, firstArchive);
        const restored = await taskRpc(host, "unarchiveTask", staleTarget);
        expect(restored.status, JSON.stringify(restored.body)).toBe(200);
        expect(await treeTask(host)).toMatchObject({ archived: false });
        const beforeRefusal = await snapshot(fixture, host.sessionId);
        const scopeBeforeRefusal = await taskScope(host);
        const refused = await taskRpc(host, "deleteArchivedTask", staleTarget);
        expect(refused.status, JSON.stringify(refused.body)).toBe(200);
        expect(refused.body.result).toBe(false);
        const retained = await snapshot(fixture, host.sessionId);
        expect(retained.taskControl).toEqual(beforeRefusal.taskControl);
        expect(retained.control.phase).toBe("completedInterrupted");
        expect(retained.control.activeWorks).toEqual([]);
        expect(retained.goal).toBeNull();
        expect(JSON.stringify(retained.rows.window)).toContain(body);
        expect(await taskScope(host)).toEqual(scopeBeforeRefusal);
        expect(await treeTask(host)).toMatchObject({ archived: false });
        expect(model.requests).toHaveLength(1);
        const archiveAgainTarget = observedArchiveTarget(host, retained);
        const archivedAgain = await taskRpc(
          host,
          "archiveTask",
          archiveAgainTarget,
        );
        expect(archivedAgain.status, JSON.stringify(archivedAgain.body)).toBe(
          200,
        );
        expect(await treeTask(host)).toMatchObject({ archived: true });
        const latestArchive = await snapshot(fixture, host.sessionId);
        const deleteTarget = observedArchiveTarget(host, latestArchive);
        const deleted = await taskRpc(host, "deleteArchivedTask", deleteTarget);
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        expect(deleted.body.result).toBe(true);
        await expectTaskAbsent(host);
        const repeated = await taskRpc(
          host,
          "deleteArchivedTask",
          deleteTarget,
        );
        expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
        expect(repeated.body.result).toBe(false);
        await expectTaskAbsent(host);
        expect(model.requests).toHaveLength(1);
        for (const late of [
          { method: "archiveTask", target: archiveTarget },
          { method: "unarchiveTask", target: staleTarget },
          { method: "archiveTask", target: archiveAgainTarget },
        ]) {
          const rejected = await taskRpc(host, late.method, late.target);
          expect(rejected.status, JSON.stringify(rejected.body)).toBe(404);
          await expectTaskAbsent(host);
          expect(model.requests).toHaveLength(1);
        }
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000);
  },
);
