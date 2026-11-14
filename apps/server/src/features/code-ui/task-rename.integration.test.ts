import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationErrorResponseSchema,
  type CodeTaskProjectMoveInput,
  codeProjectTreeSchema,
  codeTaskScopeResponseSchema,
  projectCreateResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { zcodeTaskMetaSchema } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { snapshot, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type RenameRequest = {
  workspacePath: string;
  workspaceIdentity: string;
  projectId: string;
  envelope: protocol.CommandEnvelope;
};

function createRenameRequest(
  host: Host,
  current: protocol.ConversationSnapshot,
  title: string,
): RenameRequest {
  if (!current.taskControl)
    throw new Error("原改名命令缺少公开Task控制观察值。");
  const taskControl = structuredClone(current.taskControl);
  return {
    workspacePath: host.workspacePath,
    workspaceIdentity: JSON.stringify([
      taskControl.projectId,
      host.workspacePath,
    ]),
    projectId: taskControl.projectId,
    envelope: {
      commandId: randomUUID(),
      clientId: host.clientId,
      sessionId: host.sessionId,
      type: "renameSession",
      payload: { title },
      taskControl,
      issuedAt: Date.now(),
    },
  };
}

function sendRename(host: Host, request: RenameRequest) {
  return host.stream.rpc("sendConversationCommandV4", [request]);
}

function readAck(response: Awaited<ReturnType<typeof sendRename>>) {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return protocol.commandAckSchema.parse(response.body.result);
}

async function expectRenameReplay(
  host: Host,
  request: RenameRequest,
  ack: protocol.CommandAck,
) {
  expect(readAck(await sendRename(host, request))).toEqual({
    ...ack,
    status: "duplicate",
  });
  const responses = await Promise.all([
    sendRename(host, request),
    sendRename(host, request),
  ]);
  for (const response of responses)
    expect(readAck(response)).toEqual({ ...ack, status: "duplicate" });
  const queried = await host.stream.rpc("queryConversationCommandsV4", [
    {
      workspacePath: request.workspacePath,
      workspaceIdentity: request.workspaceIdentity,
      commands: [
        {
          sessionId: request.envelope.sessionId,
          commandId: request.envelope.commandId,
        },
      ],
    },
  ]);
  expect(queried.status, JSON.stringify(queried.body)).toBe(200);
  expect(
    protocol.commandsQueryResultSchema.parse(queried.body.result).results,
  ).toEqual([
    {
      key: {
        sessionId: request.envelope.sessionId,
        commandId: request.envelope.commandId,
      },
      result: ack,
    },
  ]);
}

async function readMeta(host: Host) {
  const response = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "getTaskMeta",
    args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return zcodeTaskMetaSchema.parse(response.body.result);
}

async function readTreeTask(host: Host) {
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
  return task;
}

async function readScope(host: Host) {
  const response = await host.client.request(
    `/api/code-ui/tasks/${host.sessionId}/scope`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskScopeResponseSchema.parse(response.body).scope;
}

async function expectTitle(
  fixture: Fixture,
  host: Host,
  title: string,
  updatedAt: number,
) {
  const current = await snapshot(fixture, host.sessionId);
  expect(current.meta).toEqual({ title, titleSource: "custom" });
  const meta = await readMeta(host);
  const tree = await readTreeTask(host);
  for (const value of [meta, tree])
    expect(value).toMatchObject({
      title,
      titleOverridden: true,
      updatedAt,
      conversationRevision: current.revision,
    });
  return { snapshot: current, meta, tree };
}

async function prepareCompletedTask(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const accepted = await host.command("sendText", {
    text: "改名保留的原始任务正文",
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(accepted.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  }); // 仅等待本例本机HTTP模型流，不属于产品治理值。
  const body = "改名前已经发表的完整助手正文";
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
    throw new AggregateError(failures, "真实改名夹具未全部关闭。");
}

async function completeAfterEmptyTitle(
  fixture: Fixture,
  host: Host,
  model: Model,
) {
  const nextInput = "空自定义标题之后的新Run不生成替代标题";
  const sent = await host.command("sendText", { text: nextInput });
  expect(readAck(sent).status).toBe("accepted");
  await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
    timeout: 30_000,
  });
  const output = "空自定义标题之后仍保留的下一轮助手正文";
  model.writeText(1, output);
  model.finish(1);
  const completed = await waitPhase(
    fixture,
    host.sessionId,
    "completedSuccess",
  );
  expect(completed.meta).toEqual({ title: "", titleSource: "custom" });
  for (const text of [
    "改名保留的原始任务正文",
    "改名前已经发表的完整助手正文",
    nextInput,
    output,
  ])
    expect(JSON.stringify(completed.rows.window)).toContain(text);
  expect(completed.control.activeWorks).toEqual([]);
  expect(await readMeta(host)).toMatchObject({
    title: "",
    titleOverridden: true,
  });
  expect(await readTreeTask(host)).toMatchObject({
    title: "",
    titleOverridden: true,
  });
  return completed;
}

async function setEmptyCustomTitle(
  fixture: Fixture,
  host: Host,
  current: protocol.ConversationSnapshot,
  updatedAt: number,
) {
  const empty = createRenameRequest(host, current, "");
  expect(readAck(await sendRename(host, empty)).status).toBe("accepted");
  const state = await expectTitle(fixture, host, "", updatedAt);
  const same = createRenameRequest(host, state.snapshot, "");
  const noop = readAck(await sendRename(host, same));
  expect(noop.status).toBe("noop");
  expect(noop.revisionAtDecision).toBe(state.snapshot.revision);
  await expectRenameReplay(host, same, noop);
  expect(await snapshot(fixture, host.sessionId)).toEqual(state.snapshot);
  expect(await readMeta(host)).toEqual(state.meta);
  expect(await readTreeTask(host)).toEqual(state.tree);
  return state;
}

async function renameDuringRun(fixture: Fixture, host: Host, model: Model) {
  const input = "运行中改名保留的原始任务正文";
  expect(readAck(await host.command("sendText", { text: input })).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
    timeout: 30_000,
  });
  const opening = "改名之前已经输出的正文";
  const middle = "改名请求同时继续输出的正文";
  const ending = "改名之后完成前继续保留的正文";
  model.writeText(0, opening);
  const running = await vi.waitFor(
    async () => {
      const current = await snapshot(fixture, host.sessionId);
      expect(current.control.phase).toBe("running");
      expect(JSON.stringify(current.rows.window)).toContain(opening);
      return current;
    },
    { timeout: 30_000 },
  );
  if (!running.taskControl) throw new Error("活动Task缺少公开控制观察值。");
  const control = structuredClone(running.taskControl);
  const missing = createRenameRequest(host, running, "缺少观察不能改名");
  delete missing.envelope.taskControl;
  expect(readAck(await sendRename(host, missing))).toMatchObject({
    status: "rejected",
    reasonCode: "proto.missingTaskControl",
  });
  const stale = createRenameRequest(host, running, "错误观察不能改名");
  stale.envelope.taskControl = {
    ...control,
    branchGeneration: control.branchGeneration + 1,
  };
  expect(readAck(await sendRename(host, stale))).toMatchObject({
    status: "stale",
    reasonCode: "proto.staleTaskControl",
  });
  expect((await snapshot(fixture, host.sessionId)).meta).toEqual(running.meta);
  const request = createRenameRequest(host, running, "运行中自定义中文标题");
  const renaming = sendRename(host, request);
  model.writeText(0, middle);
  const ack = readAck(await renaming);
  expect(ack.status).toBe("accepted");
  model.writeText(0, ending);
  model.finish(0);
  const completed = await waitPhase(
    fixture,
    host.sessionId,
    "completedSuccess",
  );
  expect(completed.meta).toEqual({
    title: "运行中自定义中文标题",
    titleSource: "custom",
  });
  expect(JSON.stringify(completed.rows.window)).toContain(
    opening + middle + ending,
  );
  expect(JSON.stringify(completed.rows.window)).toContain(input);
  expect(completed.control.activeWorks).toEqual([]);
  expect(completed.taskControl).toEqual(control);
  expect(completed.goal).toEqual(running.goal);
  return { completed, request, ack };
}

async function moveRenamedTask(
  fixture: Fixture,
  host: Host,
  current: protocol.ConversationSnapshot,
) {
  if (!current.taskControl) throw new Error("移动Task缺少公开控制观察值。");
  const directory = join(fixture.directory, "改名保持的目标项目");
  await mkdir(directory);
  const created = await host.client.request("/api/projects", {
    name: "改名保持的目标项目",
    kind: "code",
    work_dir: directory,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const project = projectCreateResponseSchema.parse(created.body).project;
  const input: CodeTaskProjectMoveInput = {
    task: {
      taskId: host.sessionId,
      workspacePath: host.workspacePath,
      workspaceIdentity: JSON.stringify([
        current.taskControl.projectId,
        host.workspacePath,
      ]),
    },
    sourceProjectId: current.taskControl.projectId,
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
  const moved = await snapshot(fixture, host.sessionId);
  expect(moved.taskControl?.projectId).toBe(project.id);
  expect(moved.taskControl?.branchGeneration).toBeGreaterThan(
    current.taskControl.branchGeneration,
  );
  return { snapshot: moved, projectId: project.id, meta: await readMeta(host) };
}

async function deleteRenamedTask(
  host: Host,
  accepted: RenameRequest,
  current: protocol.ConversationSnapshot,
) {
  const late = createRenameRequest(host, current, "删除后迟到的新改名");
  const deleted = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "deleteTask",
    args: [
      {
        taskId: host.sessionId,
        workspacePath: accepted.workspacePath,
        workspaceIdentity: accepted.workspaceIdentity,
        taskControl: current.taskControl,
      },
    ],
  });
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  for (const request of [accepted, late]) {
    const response = await sendRename(host, request);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(applicationErrorResponseSchema.parse(response.body).error.code).toBe(
      "code_ui_not_found",
    );
  }
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

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原Task改名的真实V4命令与PostgreSQL integration",
  () => {
    it("原renameSession更新唯一持久标题并保留正文、Run、Goal、活动时间与目录权限", async () => {
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
        const treeBefore = await readTreeTask(host);
        expect(before.meta.titleSource).toBe("generated");
        expect(initial.titleOverridden).toBe(false);
        if (!before.taskControl)
          throw new Error("原改名命令缺少公开Task控制观察值。");
        const taskControl = structuredClone(before.taskControl);
        const commandId = randomUUID();
        const title = "自定义中文标题";
        const response = await host.command(
          "renameSession",
          { title },
          commandId,
          { taskControl },
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(
          protocol.commandAckSchema.parse(response.body.result),
        ).toMatchObject({
          commandId,
          status: "accepted",
        });
        const current = await snapshot(fixture, host.sessionId);
        const renamed = await readMeta(host);
        expect(renamed).toEqual({
          ...initial,
          title,
          titleOverridden: true,
          conversationRevision: current.revision,
        });
        expect(renamed.updatedAt).toBe(initial.updatedAt);
        const treeAfter = await readTreeTask(host);
        expect(treeAfter).toEqual({
          ...treeBefore,
          title,
          titleOverridden: true,
          conversationRevision: current.revision,
        });
        expect(treeAfter.updatedAt).toBe(treeBefore.updatedAt);
        expect(current.meta).toEqual({ title, titleSource: "custom" });
        expect(current.rows.window).toEqual(before.rows.window);
        expect(current.control).toEqual(before.control);
        expect(current.goal).toEqual(before.goal);
        expect(current.config).toEqual(before.config);
        expect(current.taskControl).toEqual(taskControl);
        expect(current.revision).toBeGreaterThan(before.revision);
        expect(current.seq).toBeGreaterThan(before.seq);
        expect(await readScope(host)).toEqual(scopeBefore);
        expect(model.requests).toHaveLength(1);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000); // 本例本机模型HTTP流、原改名命令及独占PostgreSQL关闭期限。

    it("原信封顺序和并发重放不改后来标题，空自定义标题跨Run保持且同值命令不推进状态", async () => {
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
        const first = createRenameRequest(host, before, "自定义标题甲");
        const concurrent = await Promise.all([
          sendRename(host, first),
          sendRename(host, first),
        ]);
        const decisions = concurrent.map(readAck);
        expect(decisions.map((ack) => ack.status).sort()).toEqual([
          "accepted",
          "duplicate",
        ]);
        const firstAck = decisions.find((ack) => ack.status === "accepted");
        if (!firstAck) throw new Error("同键原改名命令没有获得唯一接纳回执。");
        const firstState = await expectTitle(
          fixture,
          host,
          "自定义标题甲",
          initial.updatedAt,
        );
        expect(firstState.snapshot.revision).toBe(before.revision + 1);
        expect(firstState.snapshot.seq).toBe(before.seq + 1);
        await expectRenameReplay(host, first, firstAck);
        expect(await snapshot(fixture, host.sessionId)).toEqual(
          firstState.snapshot,
        );

        const second = createRenameRequest(
          host,
          firstState.snapshot,
          "自定义标题乙",
        );
        const secondAck = readAck(await sendRename(host, second));
        expect(secondAck.status).toBe("accepted");
        const secondState = await expectTitle(
          fixture,
          host,
          "自定义标题乙",
          initial.updatedAt,
        );
        const third = createRenameRequest(
          host,
          secondState.snapshot,
          "自定义标题甲",
        );
        const thirdAck = readAck(await sendRename(host, third));
        expect(thirdAck.status).toBe("accepted");
        const thirdState = await expectTitle(
          fixture,
          host,
          "自定义标题甲",
          initial.updatedAt,
        );
        for (const previous of [
          { request: first, ack: firstAck },
          { request: second, ack: secondAck },
        ]) {
          await expectRenameReplay(host, previous.request, previous.ack);
          expect(await snapshot(fixture, host.sessionId)).toEqual(
            thirdState.snapshot,
          );
          expect(await readMeta(host)).toEqual(thirdState.meta);
          expect(await readTreeTask(host)).toEqual(thirdState.tree);
        }
        const conflict = await sendRename(host, {
          ...first,
          envelope: { ...first.envelope, payload: { title: "同键另一个标题" } },
        });
        expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
        expect(
          applicationErrorResponseSchema.parse(conflict.body).error.code,
        ).toBe("code_ui_command_conflict");
        expect(await snapshot(fixture, host.sessionId)).toEqual(
          thirdState.snapshot,
        );

        const emptyState = await setEmptyCustomTitle(
          fixture,
          host,
          thirdState.snapshot,
          initial.updatedAt,
        );
        expect(emptyState.snapshot.rows.window).toEqual(before.rows.window);
        expect(await readScope(host)).toEqual(scopeBefore);

        const completed = await completeAfterEmptyTitle(fixture, host, model);
        expect(completed.taskControl).toEqual(before.taskControl);
        expect(completed.goal).toEqual(before.goal);
        expect(await readScope(host)).toEqual(scopeBefore);
        expect(model.requests).toHaveLength(2);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000); // 本例原命令重放、查询、两轮模型HTTP流及独占PostgreSQL关闭期限。

    it("活动Run改名后继续输出，旧控制和移动旧观察不写标题且删除后迟到命令不恢复Task", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const scopeBefore = await readScope(host);
        const active = await renameDuringRun(fixture, host, model);
        expect(await readScope(host)).toEqual(scopeBefore);
        const moved = await moveRenamedTask(fixture, host, active.completed);
        expect(moved.snapshot.meta).toEqual(active.completed.meta);
        expect(moved.snapshot.rows.window).toEqual(
          active.completed.rows.window,
        );
        expect(moved.snapshot.goal).toEqual(active.completed.goal);
        const movedScope = await readScope(host);
        expect(movedScope).toEqual({
          ...scopeBefore,
          projectId: moved.projectId,
          generation: scopeBefore.generation + 1,
        });
        const stale = createRenameRequest(
          host,
          moved.snapshot,
          "旧观察不写标题",
        );
        stale.envelope.taskControl = structuredClone(
          active.request.envelope.taskControl,
        );
        expect(readAck(await sendRename(host, stale))).toMatchObject({
          status: "stale",
          reasonCode: "proto.staleTaskControl",
        });
        expect(await snapshot(fixture, host.sessionId)).toEqual(moved.snapshot);
        const current = createRenameRequest(
          host,
          moved.snapshot,
          "移动后自定义中文标题",
        );
        expect(readAck(await sendRename(host, current)).status).toBe(
          "accepted",
        );
        const renamed = await expectTitle(
          fixture,
          host,
          "移动后自定义中文标题",
          moved.meta.updatedAt,
        );
        expect(renamed.snapshot.rows.window).toEqual(
          active.completed.rows.window,
        );
        expect(renamed.snapshot.goal).toEqual(active.completed.goal);
        expect(await readScope(host)).toEqual(movedScope);
        const replay = readAck(
          await sendRename(host, {
            ...current,
            envelope: active.request.envelope,
          }),
        );
        expect(replay).toEqual({ ...active.ack, status: "duplicate" });
        expect(await snapshot(fixture, host.sessionId)).toEqual(
          renamed.snapshot,
        );
        expect(await readMeta(host)).toEqual(renamed.meta);
        await deleteRenamedTask(host, current, renamed.snapshot);
        expect(model.requests).toHaveLength(1);
      } finally {
        await closeFixture(fixture, model, host);
      }
    }, 90_000); // 本例活动输出、原V4命令、移动删除及独占PostgreSQL关闭期限。
  },
);
