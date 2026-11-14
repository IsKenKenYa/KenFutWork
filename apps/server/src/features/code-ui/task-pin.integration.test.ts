import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationErrorResponseSchema,
  type CodeTaskOrganizationTarget,
  type CodeTaskProjectMoveInput,
  codeProjectTreeSchema,
  codeTaskPinMetaSchema,
  codeTaskScopeResponseSchema,
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type PinObservation = CodeTaskOrganizationTarget & {
  observedPinRevision: number;
};
const taskMetaSchema = codeTaskPinMetaSchema;
type TaskMeta = z.infer<typeof taskMetaSchema>;

function observedPinTarget(meta: TaskMeta): PinObservation {
  if (!meta.workspaceIdentity || !meta.taskControl)
    throw new Error("置顶操作缺少公开Task身份与观察值。");
  return {
    taskId: meta.taskId,
    workspacePath: meta.workspacePath,
    workspaceIdentity: meta.workspaceIdentity,
    taskControl: structuredClone(meta.taskControl),
    observedPinRevision: meta.pinRevision,
  };
}

async function readMeta(
  host: Host,
  client: Pick<Host["client"], "request"> = host.client,
) {
  const response = await client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "getTaskMeta",
    args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return taskMetaSchema.parse(response.body.result);
}

async function setPinned(
  host: Host,
  address: PinObservation,
  pinned: boolean,
  controller = false,
) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: controller ? "window-controller" : "zcode-task",
    method: controller ? "mutateTask" : "setTaskPinned",
    args: [
      controller
        ? { address, mutation: { kind: "pin", pinned } }
        : { ...address, pinned },
    ],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return taskMetaSchema.parse(response.body.result);
}

async function expectPinReplay(
  host: Host,
  address: PinObservation,
  pinned: boolean,
  result: TaskMeta,
) {
  expect(await setPinned(host, address, pinned)).toEqual(result);
  const responses = await Promise.all([
    setPinned(host, address, pinned),
    setPinned(host, address, pinned, true),
  ]);
  for (const response of responses) expect(response).toEqual(result);
}

async function expectPinError(
  host: Host,
  input: unknown,
  status: number,
  code: string,
  controller = false,
) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: controller ? "window-controller" : "zcode-task",
    method: controller ? "mutateTask" : "setTaskPinned",
    args: [input],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(applicationErrorResponseSchema.parse(response.body).error.code).toBe(
    code,
  );
}

async function expectInvalidPinInputs(host: Host, address: PinObservation) {
  const input = { ...address, pinned: true };
  for (const change of [
    { observedPinRevision: undefined },
    { observedPinRevision: -1 },
    { observedPinRevision: 1.5 },
    { observedPinRevision: Number.MAX_SAFE_INTEGER + 1 },
    { taskControl: undefined },
    { pinned: "true" },
    { extraField: true },
  ])
    await expectPinError(
      host,
      { ...input, ...change },
      400,
      "invalid_code_ui_request",
    );
  for (const change of [
    { workspacePath: `${address.workspacePath}/other` },
    { workspaceIdentity: "other-workspace" },
  ])
    await expectPinError(
      host,
      { ...input, ...change },
      409,
      "task_pin_conflict",
    );
  await expectPinError(
    host,
    { address, mutation: { kind: "pin", pinned: "false" } },
    400,
    "invalid_code_ui_request",
    true,
  );
}

async function readScope(host: Host) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function expectPinnedMembership(
  host: Host,
  meta: TaskMeta,
  pinned: boolean,
) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "readTree",
    args: [{ hostId: "local" }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const task = codeProjectTreeSchema
    .parse(response.body.result)
    .tasks.find((entry) => entry.taskId === host.sessionId);
  if (!task) throw new Error("公开项目树缺少本例已发表的根Task。");
  expect(task).toMatchObject({
    pinned,
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
  ).toBe(pinned);
}

async function movePinnedTask(
  fixture: Fixture,
  host: Host,
  meta: TaskMeta,
  current: protocol.ConversationSnapshot,
) {
  const directory = join(fixture.directory, "置顶保持的目标项目");
  await mkdir(directory);
  const created = await host.client.request("/api/projects", {
    name: "置顶保持的目标项目",
    kind: "code",
    work_dir: directory,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const project = projectCreateResponseSchema.parse(created.body).project;
  const target = observedPinTarget(meta);
  const input: CodeTaskProjectMoveInput = {
    task: {
      taskId: target.taskId,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
    },
    sourceProjectId: target.taskControl.projectId,
    projectId: project.id,
    observedRevision: current.revision,
    addMissingRoot: true,
  };
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "moveTask",
    args: [input],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body).toEqual({ result: null });
  const moved = await readMeta(host);
  expect(moved.taskControl?.projectId).toBe(project.id);
  expect(moved.taskControl?.branchGeneration).toBeGreaterThan(
    target.taskControl.branchGeneration,
  );
  return moved;
}

async function deletePinnedTask(
  host: Host,
  current: PinObservation,
  original: PinObservation,
) {
  const deleted = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "deleteTask",
    args: [
      {
        taskId: current.taskId,
        workspacePath: current.workspacePath,
        workspaceIdentity: current.workspaceIdentity,
        taskControl: current.taskControl,
      },
    ],
  });
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  for (const input of [
    { ...original, pinned: true },
    { ...current, pinned: false },
  ])
    await expectPinError(host, input, 404, "code_ui_not_found");
  const missing = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "getTaskMeta",
    args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
  });
  expect(missing.status, JSON.stringify(missing.body)).toBe(200);
  expect(missing.body.result).toBeNull();
  for (const path of [
    `/api/code-ui/sessions/${host.sessionId}`,
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  ]) {
    const response = await host.client.request(path);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
  }
}

async function prepareCompletedTask(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const accepted = await host.command("sendText", {
    text: "置顶操作保留的原始任务正文",
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(accepted.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  }); // 仅等待本例本机HTTP模型流，不属于产品治理值。
  const body = "置顶操作前已经发表的助手正文";
  model.writeText(0, body);
  model.finish(0);
  const completed = await waitPhase(
    fixture,
    host.sessionId,
    "completedSuccess",
  );
  expect(JSON.stringify(completed.rows.window)).toContain(body);
  expect(completed.control.activeWorks).toEqual([]);
  await vi.waitFor(() => expect(model.requests[0]?.closed).toBe(true));
  return snapshot(fixture, host.sessionId);
}

async function sendInput(host: Host, text: string) {
  const response = await host.command("sendText", { text });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(response.body.result).status).toBe(
    "accepted",
  );
}

async function waitForAssistantText(
  fixture: Fixture,
  taskId: string,
  text: string,
) {
  let current: protocol.ConversationSnapshot | undefined;
  await vi.waitFor(
    async () => {
      current = await snapshot(fixture, taskId);
      const output = current.rows.window
        .flatMap((row) => (row.kind === "assistantText" ? [row.text] : []))
        .join("");
      expect(output).toContain(text);
    },
    { timeout: 30_000 },
  ); // 仅等待真实模型HTTP输出进入公开快照。
  if (!current) throw new Error("未读取公开模型输出快照。");
  return current;
}

async function completeFollowingRun(
  fixture: Fixture,
  host: Host,
  model: Model,
  firstInput: string,
  firstOutput: string,
) {
  const nextInput = "下一真实Run继续保留原Task正文与置顶状态";
  await sendInput(host, nextInput);
  await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
    timeout: 30_000,
  });
  const output = "第二轮继续生成的完整助手正文";
  model.writeText(1, output);
  const running = await waitForAssistantText(fixture, host.sessionId, output);
  expect(running.control.phase).toBe("running");
  expect(JSON.stringify(running.rows.window)).toContain(firstOutput);
  model.finish(1);
  const completed = await waitPhase(
    fixture,
    host.sessionId,
    "completedSuccess",
  );
  for (const text of [firstOutput, output, firstInput, nextInput])
    expect(JSON.stringify(completed.rows.window)).toContain(text);
  expect(completed.control.activeWorks).toEqual([]);
  return completed;
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
    throw new AggregateError(failures, "真实置顶夹具未全部关闭。");
}

async function initializeObserver(fixture: Fixture) {
  const stream = await fixture.client.openCodeStream();
  const response = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      clientId: randomUUID(),
      appVersion: "task-pin-connection-integration",
      clientKind: "web",
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return stream;
}

async function expectClosedConnection(fixture: Fixture, connectionId: string) {
  await expect
    .poll(async () => {
      const response = await fixture.client.request("/api/code-ui/rpc", {
        connectionId,
        service: "project",
        method: "readProjects",
        args: [],
      });
      return response.status;
    })
    .toBe(404);
}

async function holdTask(fixture: Fixture, host: Host) {
  const blocker = new Client({
    connectionString: fixture.database.connectionString,
  });
  await blocker.connect();
  let held = false;
  try {
    await blocker.query("begin");
    held = true;
    const locked = await blocker.query<{ id: string }>(
      "select id from public.code_ui_sessions where instance_id=$1 and id=$2 for update",
      [fixture.actor.instanceId, host.sessionId],
    );
    expect(locked.rows).toEqual([{ id: host.sessionId }]);
    const identity = await blocker.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    const pid = identity.rows[0]?.pid;
    if (pid === undefined) throw new Error("数据库锁连接缺少进程身份。");
    const release = async () => {
      if (!held) return;
      await blocker.query("rollback");
      held = false;
    };
    return {
      release,
      async waitBlocked() {
        await expect
          .poll(async () => {
            await blocker.query("select pg_stat_clear_snapshot()");
            const waiting = await blocker.query(
              `select pid from pg_stat_activity
                where datname=current_database() and pid<>pg_backend_pid()
                  and state='active' and wait_event_type='Lock'
                  and $1=any(pg_blocking_pids(pid))`,
              [pid],
            );
            return waiting.rows.length;
          })
          .toBe(1);
      },
      async close() {
        try {
          await release();
        } finally {
          await blocker.end();
        }
      },
    };
  } catch (error) {
    try {
      if (held) await blocker.query("rollback");
    } finally {
      await blocker.end();
    }
    throw error;
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原Task置顶的真实HTTP/RPC与PostgreSQL integration",
  () => {
    it("两个原入口置顶、取消及再次置顶推进独立修订，Task正文、活动时间和权限保持", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const before = await prepareCompletedTask(fixture, host, model);
        const scopeBefore = await readScope(host);
        const initial = await readMeta(host);
        expect(initial.pinRevision).toBe(0);
        await expectPinnedMembership(host, initial, false);

        const first = await setPinned(host, observedPinTarget(initial), true);
        expect(first.pinRevision).toBe(1);
        expect(first.updatedAt).toBe(initial.updatedAt);
        expect(await readMeta(host)).toEqual(first);
        await expectPinnedMembership(host, first, true);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);

        const unpinned = await setPinned(
          host,
          observedPinTarget(first),
          false,
          true,
        );
        expect(unpinned.pinRevision).toBe(2);
        expect(unpinned.updatedAt).toBe(initial.updatedAt);
        expect(await readMeta(host)).toEqual(unpinned);
        await expectPinnedMembership(host, unpinned, false);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);

        const pinnedAgain = await setPinned(
          host,
          observedPinTarget(unpinned),
          true,
        );
        expect(pinnedAgain.pinRevision).toBe(3);
        expect(pinnedAgain.updatedAt).toBe(initial.updatedAt);
        expect(await readMeta(host)).toEqual(pinnedAgain);
        await expectPinnedMembership(host, pinnedAgain, true);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);
        expect(model.requests).toHaveLength(1);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000); // 本例本机模型HTTP流、原任务完成与独占PostgreSQL关闭期限。

    it("同键顺序和并发重放保持原结果，同值不推进修订且旧回执和错误观察不覆盖后来置顶", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const before = await prepareCompletedTask(fixture, host, model);
        const scopeBefore = await readScope(host);
        const initial = await readMeta(host);
        const initialAddress = observedPinTarget(initial);
        const unchanged = await setPinned(host, initialAddress, false);
        expect(unchanged).toEqual(initial);
        expect(unchanged.pinRevision).toBe(0);
        await expectPinReplay(host, initialAddress, false, unchanged);

        const [first, concurrent] = await Promise.all([
          setPinned(host, initialAddress, true),
          setPinned(host, initialAddress, true, true),
        ]);
        expect(first.pinRevision).toBe(1);
        expect(concurrent).toEqual(first);
        await expectPinReplay(host, initialAddress, true, first);
        const firstAddress = observedPinTarget(first);
        const samePinned = await setPinned(host, firstAddress, true);
        expect(samePinned).toEqual(first);
        await expectPinReplay(host, firstAddress, true, samePinned);

        const unpinned = await setPinned(host, firstAddress, false, true);
        expect(unpinned.pinRevision).toBe(2);
        const unpinnedAddress = observedPinTarget(unpinned);
        const pinnedAgain = await setPinned(host, unpinnedAddress, true);
        expect(pinnedAgain.pinRevision).toBe(3);
        expect(pinnedAgain.updatedAt).toBe(initial.updatedAt);

        for (const previous of [
          { address: initialAddress, pinned: false, result: unchanged },
          { address: initialAddress, pinned: true, result: first },
          { address: firstAddress, pinned: true, result: samePinned },
          { address: firstAddress, pinned: false, result: unpinned },
        ]) {
          await expectPinReplay(
            host,
            previous.address,
            previous.pinned,
            previous.result,
          );
          expect(await readMeta(host)).toEqual(pinnedAgain);
          await expectPinnedMembership(host, pinnedAgain, true);
        }
        const currentAddress = observedPinTarget(pinnedAgain);
        const currentNoop = await setPinned(host, currentAddress, true, true);
        expect(currentNoop).toEqual(pinnedAgain);
        expect(currentNoop.pinRevision).toBe(3);
        await expectPinReplay(host, currentAddress, true, currentNoop);
        await expectPinError(
          host,
          { ...unpinnedAddress, pinned: false },
          409,
          "task_pin_conflict",
        );
        await expectInvalidPinInputs(host, currentAddress);
        expect(await readMeta(host)).toEqual(pinnedAgain);
        await expectPinnedMembership(host, pinnedAgain, true);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);
        expect(model.requests).toHaveLength(1);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000); // 本例真实并发RPC、原任务完成及独占PostgreSQL关闭期限。

    it("真实模型持续输出期间置顶与取消不干扰运行保存，下一Run保留完整正文、置顶修订和权限", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const scopeBefore = await readScope(host);
        const firstInput = "持续输出期间组织Task的首轮输入";
        await sendInput(host, firstInput);
        await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        const opening = "首轮已经进入真实流的开头";
        const duringPin = "置顶请求同时到达的正文";
        const beforeUnpin = "取消置顶前继续输出的正文";
        const duringUnpin = "取消请求同时到达的正文";
        const ending = "首轮完成前保留的尾部正文";
        const parts = [opening, duringPin, beforeUnpin, duringUnpin, ending];
        model.writeText(0, opening);
        const running = await waitForAssistantText(
          fixture,
          host.sessionId,
          opening,
        );
        expect(running.control.phase).toBe("running");
        const initial = await readMeta(host);
        expect(initial.pinRevision).toBe(0);

        const pinning = setPinned(host, observedPinTarget(initial), true);
        model.writeText(0, duringPin);
        const [pinned, afterPin] = await Promise.all([
          pinning,
          waitForAssistantText(
            fixture,
            host.sessionId,
            parts.slice(0, 2).join(""),
          ),
        ]);
        expect(pinned.pinRevision).toBe(1);
        expect(afterPin.control.phase).toBe("running");
        expect(afterPin.taskControl).toEqual(running.taskControl);
        expect(await readScope(host)).toEqual(scopeBefore);
        expect(model.requests[0]?.closed).toBe(false);
        await expectPinnedMembership(host, await readMeta(host), true);

        model.writeText(0, beforeUnpin);
        await waitForAssistantText(
          fixture,
          host.sessionId,
          parts.slice(0, 3).join(""),
        );
        const unpinning = setPinned(
          host,
          observedPinTarget(pinned),
          false,
          true,
        );
        model.writeText(0, duringUnpin);
        const [unpinned, afterUnpin] = await Promise.all([
          unpinning,
          waitForAssistantText(
            fixture,
            host.sessionId,
            parts.slice(0, 4).join(""),
          ),
        ]);
        expect(unpinned.pinRevision).toBe(2);
        expect(afterUnpin.control.phase).toBe("running");
        expect(afterUnpin.taskControl).toEqual(running.taskControl);
        expect(await readScope(host)).toEqual(scopeBefore);
        expect(model.requests[0]?.closed).toBe(false);
        model.writeText(0, ending);
        model.finish(0);
        const firstEnd = await waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        expect(JSON.stringify(firstEnd.rows.window)).toContain(parts.join(""));
        expect(firstEnd.control.activeWorks).toEqual([]);
        const firstMeta = await readMeta(host);
        expect(firstMeta.pinRevision).toBe(2);
        await expectPinnedMembership(host, firstMeta, false);

        const secondEnd = await completeFollowingRun(
          fixture,
          host,
          model,
          firstInput,
          parts.join(""),
        );
        expect(secondEnd.taskControl).toEqual(running.taskControl);
        const final = await readMeta(host);
        expect(final.pinRevision).toBe(2);
        await expectPinnedMembership(host, final, false);
        expect(await readScope(host)).toEqual(scopeBefore);
        expect(model.requests).toHaveLength(2);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000); // 本例两轮本机模型HTTP流及独占PostgreSQL关闭期限。

    it("移动保留置顶修订并拒绝旧项目、分支和回执，删除后迟到请求不能恢复Task", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const before = await prepareCompletedTask(fixture, host, model);
        const initial = await readMeta(host);
        const original = observedPinTarget(initial);
        const pinned = await setPinned(host, original, true);
        expect(pinned.pinRevision).toBe(1);
        const old = observedPinTarget(pinned);
        const moved = await movePinnedTask(fixture, host, pinned, before);
        expect(moved.pinRevision).toBe(pinned.pinRevision);
        await expectPinnedMembership(host, moved, true);
        await expectPinError(
          host,
          { ...original, pinned: true },
          409,
          "task_pin_conflict",
        );
        await expectPinError(
          host,
          { address: old, mutation: { kind: "pin", pinned: false } },
          409,
          "task_pin_conflict",
          true,
        );
        const current = observedPinTarget(moved);
        await expectPinError(
          host,
          {
            ...current,
            taskControl: {
              ...current.taskControl,
              branchGeneration: old.taskControl.branchGeneration,
            },
            pinned: false,
          },
          409,
          "task_pin_conflict",
        );
        expect(await readMeta(host)).toEqual(moved);
        const movedSnapshot = await snapshot(fixture, host.sessionId);
        expect(movedSnapshot.rows.window).toEqual(before.rows.window);
        expect(movedSnapshot.goal).toEqual(before.goal);
        const movedScope = await readScope(host);
        const unpinned = await setPinned(host, current, false, true);
        expect(unpinned.pinRevision).toBe(2);
        await expectPinnedMembership(host, unpinned, false);
        expect(await snapshot(fixture, host.sessionId)).toEqual(movedSnapshot);
        expect(await readScope(host)).toEqual(movedScope);

        await deletePinnedTask(host, current, original);
        expect(model.requests).toHaveLength(1);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000); // 本例原移动、删除及独占PostgreSQL关闭期限。

    it("连接关闭取消等待根Task锁的置顶，释放后无写入且新连接可用同一意图继续", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      let blocker: Awaited<ReturnType<typeof holdTask>> | undefined;
      let writing: ReturnType<Fixture["client"]["request"]> | undefined;
      const failures: unknown[] = [];
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const before = await prepareCompletedTask(fixture, host, model);
        const scopeBefore = await readScope(host);
        const initial = await readMeta(host);
        expect(initial.pinned).toBe(false);
        expect(initial.pinRevision).toBe(0);
        const input = { ...observedPinTarget(initial), pinned: true };
        const observer = await initializeObserver(fixture);
        blocker = await holdTask(fixture, host);
        writing = host.client.request("/api/code-ui/rpc", {
          service: "zcode-task",
          method: "setTaskPinned",
          args: [input],
        });
        let settled = false;
        void writing.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await blocker.waitBlocked();
        host.stream.controller.abort();
        await host.stream.closed;
        await expectClosedConnection(
          fixture,
          host.stream.ready.hello.connectionId,
        );
        expect(settled).toBe(false);
        await blocker.release();
        const rejected = await writing;
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(404);
        const error = applicationErrorResponseSchema.parse(rejected.body).error;
        expect(error.code).toBe("code_ui_not_found");
        expect(error.message).toContain("连接");
        expect(await readMeta(host, fixture.client)).toEqual(initial);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);
        const continued = await fixture.client.request("/api/code-ui/rpc", {
          connectionId: observer.ready.hello.connectionId,
          service: "zcode-task",
          method: "setTaskPinned",
          args: [input],
        });
        expect(continued.status, JSON.stringify(continued.body)).toBe(200);
        const pinned = taskMetaSchema.parse(continued.body.result);
        expect(pinned.pinned).toBe(true);
        expect(pinned.pinRevision).toBe(1);
        expect(pinned.updatedAt).toBe(initial.updatedAt);
        expect(await readMeta(host, fixture.client)).toEqual(pinned);
        expect(await snapshot(fixture, host.sessionId)).toEqual(before);
        expect(await readScope(host)).toEqual(scopeBefore);
        expect(model.requests).toHaveLength(1);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => blocker?.release(),
          () => writing?.then(() => undefined),
          () => blocker?.close(),
          () => closeFixture(fixture, model, host),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "置顶关闭验证或清理失败。", {
          cause: failures[0],
        });
    }, 90_000); // 本例原SSE关闭、真实PG锁等待及全部资源释放的期限。

    it("两个独立实例交换完整Task地址时分别拒绝直接与Controller置顶，各自状态保持", async () => {
      const leftFixture = await createCodeUiHttpFixture();
      const leftModel = await heldModel();
      let left: Host | undefined;
      let rightFixture: Fixture | undefined;
      let rightModel: Model | undefined;
      let right: Host | undefined;
      const failures: unknown[] = [];
      try {
        left = await createCodeSessionFixture(leftModel.baseUrl, {
          client: leftFixture.client,
        });
        const leftBefore = await prepareCompletedTask(
          leftFixture,
          left,
          leftModel,
        );
        const leftScope = await readScope(left);
        rightFixture = await createCodeUiHttpFixture();
        rightModel = await heldModel();
        right = await createCodeSessionFixture(rightModel.baseUrl, {
          client: rightFixture.client,
        });
        const rightBefore = await prepareCompletedTask(
          rightFixture,
          right,
          rightModel,
        );
        const rightScope = await readScope(right);
        expect(rightFixture.actor.instanceId).not.toBe(
          leftFixture.actor.instanceId,
        );
        const leftPinned = await setPinned(
          left,
          observedPinTarget(await readMeta(left)),
          true,
        );
        const rightPinned = await setPinned(
          right,
          observedPinTarget(await readMeta(right)),
          true,
        );
        await expectPinError(
          left,
          { ...observedPinTarget(rightPinned), pinned: false },
          404,
          "code_ui_not_found",
        );
        await expectPinError(
          right,
          {
            address: observedPinTarget(leftPinned),
            mutation: { kind: "pin", pinned: false },
          },
          404,
          "code_ui_not_found",
          true,
        );
        expect(await readMeta(left)).toEqual(leftPinned);
        expect(await readMeta(right)).toEqual(rightPinned);
        await expectPinnedMembership(left, leftPinned, true);
        await expectPinnedMembership(right, rightPinned, true);
        expect(await snapshot(leftFixture, left.sessionId)).toEqual(leftBefore);
        expect(await snapshot(rightFixture, right.sessionId)).toEqual(
          rightBefore,
        );
        expect(await readScope(left)).toEqual(leftScope);
        expect(await readScope(right)).toEqual(rightScope);
        expect(leftModel.requests).toHaveLength(1);
        expect(rightModel.requests).toHaveLength(1);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          async () => {
            if (rightFixture && rightModel)
              await closeFixture(rightFixture, rightModel, right);
            else await rightFixture?.close();
          },
          () => closeFixture(leftFixture, leftModel, left),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "两个实例的置顶验证或清理失败。", {
          cause: failures[0],
        });
    }, 120_000); // 两个独占HTTP/SSE、模型端点与PostgreSQL实例的关闭期限。
  },
);
