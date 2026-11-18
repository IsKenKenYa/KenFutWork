import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  type CodeTaskGroupMove,
  type CodeTaskGroupStructure,
  type CodeTaskGroupTaskRef,
  type CodeTaskOrganizationTarget,
  codeTaskGroupSchema,
  codeTaskGroupStructureSchema,
  codeUiRpcResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const http = useCodeUiHttpFixture();
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type TaskFixture = {
  host: Host;
  model: Awaited<ReturnType<typeof heldModel>>;
  tasks: CodeTaskGroupTaskRef[];
};

function rpc(method: string, args: unknown[] = []) {
  return http.request("/api/code-ui/rpc", {
    service: "task-groups",
    method,
    args,
  });
}

async function read() {
  const response = await rpc("read");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskGroupStructureSchema.parse(response.body.result);
}

function taskReference(host: Host, taskId: string): CodeTaskGroupTaskRef {
  return {
    hostId: "local",
    taskId,
    workspacePath: host.workspacePath,
    workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
  };
}

function taskAt(fixture: TaskFixture, position: number) {
  const task = fixture.tasks[position];
  if (!task) throw new Error("真实回归材料缺少指定根 Task。");
  return task;
}

async function taskSnapshot(taskId: string) {
  const response = await http.request(`/api/code-ui/sessions/${taskId}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return protocol.conversationSnapshotSchema.parse(response.body.snapshot);
}

async function taskState(task: CodeTaskGroupTaskRef, scopeStatus = 200) {
  const scope = await http.request(`/api/code-ui/tasks/${task.taskId}/scope`);
  expect(scope.status, JSON.stringify(scope.body)).toBe(scopeStatus);
  return { scope, snapshot: await taskSnapshot(task.taskId) };
}

async function createRootTask(host: Host) {
  const selection = (await taskSnapshot(host.sessionId)).config.modelSelection;
  const response = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: host.projectId,
          config: { modelSelection: selection },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(response.body.result);
  expect(ack.status).toBe("accepted");
  if (ack.result?.type !== "createSession")
    throw new Error("公开创建回执未返回真实根 Task。");
  return taskReference(host, ack.result.sessionId);
}

async function withTasks(
  count: number,
  run: (fixture: TaskFixture) => Promise<void>,
) {
  const model = await heldModel();
  let host: Host | undefined;
  const failures: unknown[] = [];
  try {
    host = await createCodeSessionFixture(model.baseUrl, { client: http });
    const tasks = [taskReference(host, host.sessionId)];
    for (let position = 1; position < count; position++)
      tasks.push(await createRootTask(host));
    await run({ host, model, tasks });
  } catch (error) {
    failures.push(error);
  } finally {
    for (const close of [() => host?.dispose(), () => model.close()]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Task 手动分组移动验证或清理失败", {
      cause: failures[0],
    });
}

async function createGroup(title: string) {
  const response = await rpc("save", [
    {
      creationId: randomUUID(),
      expectedRevision: (await read()).revision,
      title,
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskGroupSchema.parse(response.body.result);
}

function taskNode(task: CodeTaskGroupTaskRef): CodeTaskGroupMove["node"] {
  return { type: "task", task };
}

function taskKey(task: CodeTaskGroupTaskRef) {
  return JSON.stringify([task.workspaceIdentity, task.taskId]);
}

function member(
  task: CodeTaskGroupTaskRef,
  groupId: string,
  sortOrder: number,
) {
  return {
    groupId,
    workspaceKey: task.workspaceIdentity,
    taskId: task.taskId,
    sortOrder,
  };
}

async function moveTask(
  task: CodeTaskGroupTaskRef,
  sourceGroupId: string | null,
  groupId: string | null,
  anchor?: CodeTaskGroupMove["anchor"],
) {
  const intent: CodeTaskGroupMove = {
    node: taskNode(task),
    sourceGroupId,
    groupId,
    expectedRevision: (await read()).revision,
    ...(anchor ? { anchor } : {}),
  };
  const response = await rpc("move", [intent]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(codeUiRpcResponseSchema.parse(response.body)).toEqual({
    result: null,
  });
  return intent;
}

function membersIn(structure: CodeTaskGroupStructure, groupId: string) {
  return structure.members.filter((entry) => entry.groupId === groupId);
}

async function expectRejected(
  args: unknown[],
  status: 400 | 404 | 409,
  before: CodeTaskGroupStructure,
) {
  const response = await rpc("move", args);
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(applicationErrorResponseSchema.parse(response.body).error.code).toBe(
    status === 400
      ? "invalid_code_ui_request"
      : status === 404
        ? "code_ui_not_found"
        : "task_group_revision_conflict",
  );
  expect(await read()).toEqual(before);
}

function malformedMoves(base: CodeTaskGroupMove, task: CodeTaskGroupTaskRef) {
  return [
    [],
    [null],
    [base, base],
    [{ ...base, unexpected: true }],
    [{ ...base, expectedRevision: -1 }],
    [{ ...base, expectedRevision: 0.5 }],
    [{ ...base, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...base, node: { ...base.node, unexpected: true } }],
    [{ ...base, node: { type: "task", task: { ...task, hostId: "remote" } } }],
    [{ ...base, anchor: { node: taskNode(task), side: "around" } }],
    [
      {
        ...base,
        anchor: {
          node: { type: "group", groupId: base.groupId },
          side: "after",
        },
      },
    ],
    [{ ...base, node: { type: "group", groupId: base.sourceGroupId } }],
    [
      {
        ...base,
        anchor: {
          node: taskNode({
            ...task,
            workspacePath: `${task.workspacePath}/另一个地址`,
          }),
          side: "after",
        },
      },
    ],
  ];
}

async function organizeHostTask(
  fixture: TaskFixture,
  method: "archiveTask" | "deleteArchivedTask",
) {
  const task = taskAt(fixture, 0);
  const current = await taskSnapshot(task.taskId);
  if (!current.taskControl) throw new Error("真实 Task 缺少当前控制观察值。");
  const target: CodeTaskOrganizationTarget = {
    taskId: task.taskId,
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskControl: structuredClone(current.taskControl),
  };
  const response = await http.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method,
    args: [target],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response;
}

async function publishAndArchiveHost(fixture: TaskFixture) {
  const text = "手动分组移动的真实归档正文";
  const sent = await fixture.host.command("sendText", { text });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(() => expect(fixture.model.requests).toHaveLength(1), {
    timeout: 30_000,
  }); // 仅等待本例受控模型的真实 HTTP 请求。
  const stopped = await fixture.host.command("stop", {});
  expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(stopped.body.result).status).toBe(
    "accepted",
  );
  await vi.waitFor(
    async () => {
      const current = await taskSnapshot(fixture.host.sessionId);
      expect(current.control.phase).toBe("completedInterrupted");
      expect(JSON.stringify(current.rows.window)).toContain(text);
      expect(fixture.model.requests[0]?.closed).toBe(true);
    },
    { timeout: 30_000 },
  ); // 仅等待本例受控模型 HTTP 流和原 Task 停止。
  await organizeHostTask(fixture, "archiveTask");
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原 Task 手动分组移动的真实 HTTP、SSE 与 PostgreSQL integration",
  () => {
    it("未登记Task可手动入组并组间返根往返，根排序与后续自然登记保持人工结果", async () => {
      await withTasks(2, async (fixture) => {
        const first = taskAt(fixture, 0);
        const second = taskAt(fixture, 1);
        const beforeTasks = await Promise.all(
          fixture.tasks.map((task) => taskState(task)),
        );
        const left = await createGroup("第一个任务组");
        const right = await createGroup("第二个任务组");
        await moveTask(first, null, left.id);
        expect(membersIn(await read(), left.id)).toEqual([
          member(first, left.id, 0),
        ]);
        const originalSecond = await moveTask(second, null, left.id, {
          node: taskNode(first),
          side: "after",
        });
        await moveTask(first, left.id, right.id);
        await moveTask(second, left.id, null, {
          node: { type: "group", groupId: right.id },
          side: "after",
        });
        await moveTask(first, right.id, null, {
          node: taskNode(second),
          side: "before",
        });
        await moveTask(second, null, null, {
          node: { type: "group", groupId: right.id },
          side: "before",
        });
        const sorted = await read();
        expect(sorted).toEqual({
          revision: 8,
          groups: [left, right],
          members: [],
          order: [
            { type: "task", key: taskKey(second), sortOrder: 0 },
            { type: "group", key: right.id, sortOrder: 1 },
            { type: "task", key: taskKey(first), sortOrder: 2 },
            { type: "group", key: left.id, sortOrder: 3 },
          ],
        });
        await moveTask(second, null, null);
        const after = { ...sorted, revision: 9 };
        expect(await read()).toEqual(after);
        const natural = await rpc("admit", [{ tasks: fixture.tasks }]);
        expect(natural.status, JSON.stringify(natural.body)).toBe(200);
        const replay = await rpc("move", [originalSecond]);
        expect(replay.status, JSON.stringify(replay.body)).toBe(200);
        expect(await read()).toEqual(after);
        expect(
          await Promise.all(fixture.tasks.map((task) => taskState(task))),
        ).toEqual(beforeTasks);
        expect(fixture.model.requests).toHaveLength(0);
      });
    }, 90_000); // 两个真实根 Task、多次公开移动和临时资源关闭的期限。

    it("非法形状及过期修订来源锚点均拒绝，自锚点和错误目录不改变结构或消费操作", async () => {
      await withTasks(3, async (fixture) => {
        const first = taskAt(fixture, 0);
        const second = taskAt(fixture, 1);
        const anchor = taskAt(fixture, 2);
        const beforeTasks = await Promise.all(
          fixture.tasks.map((task) => taskState(task)),
        );
        const left = await createGroup("来源组");
        const right = await createGroup("目标组");
        await moveTask(first, null, left.id);
        await moveTask(second, null, right.id);
        await moveTask(anchor, null, right.id);
        await moveTask(anchor, right.id, null, {
          node: { type: "group", groupId: left.id },
          side: "after",
        });
        const before = await read();
        expect(before.revision).toBe(6);
        const base: CodeTaskGroupMove = {
          node: taskNode(first),
          sourceGroupId: left.id,
          groupId: right.id,
          expectedRevision: before.revision,
          anchor: { node: taskNode(second), side: "after" },
        };
        for (const args of malformedMoves(base, first))
          await expectRejected(args, 400, before);
        for (const input of [
          { ...base, expectedRevision: 3 },
          { ...base, sourceGroupId: right.id },
          { ...base, anchor: { node: taskNode(anchor), side: "after" } },
          {
            ...base,
            node: taskNode({
              ...first,
              workspacePath: `${first.workspacePath}/旧目录`,
            }),
          },
          {
            ...base,
            node: taskNode({
              ...first,
              workspaceIdentity: JSON.stringify([
                randomUUID(),
                first.workspacePath,
              ]),
            }),
          },
          {
            node: taskNode(anchor),
            sourceGroupId: null,
            groupId: null,
            expectedRevision: 6,
            anchor: { node: taskNode(anchor), side: "before" },
          },
          {
            node: { type: "group", groupId: left.id },
            sourceGroupId: left.id,
            groupId: null,
            expectedRevision: 6,
          },
        ])
          await expectRejected([input], 409, before);
        for (const input of [
          { ...base, groupId: randomUUID() },
          { ...base, node: taskNode({ ...first, taskId: randomUUID() }) },
          {
            node: { type: "group", groupId: randomUUID() },
            sourceGroupId: null,
            groupId: null,
            expectedRevision: 6,
          },
        ])
          await expectRejected([input], 404, before);
        const valid = await rpc("move", [{ ...base, anchor: undefined }]);
        expect(valid.status, JSON.stringify(valid.body)).toBe(200);
        const after = await read();
        expect(after.revision).toBe(7);
        expect(membersIn(after, left.id)).toEqual([]);
        expect(membersIn(after, right.id)).toEqual([
          member(first, right.id, 0),
          member(second, right.id, 1),
        ]);
        expect(after.order).toEqual(before.order);
        expect(
          await Promise.all(fixture.tasks.map((task) => taskState(task))),
        ).toEqual(beforeTasks);
        expect(fixture.model.requests).toHaveLength(0);
      });
    }, 90_000);

    it("真实归档隐藏成员参与跨组和返根排序，归档节点或锚点的新移动被拒绝", async () => {
      await withTasks(3, async (fixture) => {
        const hidden = taskAt(fixture, 0);
        const visible = taskAt(fixture, 1);
        const moving = taskAt(fixture, 2);
        const left = await createGroup("包含隐藏成员的组");
        const right = await createGroup("暂存组");
        await moveTask(hidden, null, left.id);
        await moveTask(visible, null, left.id, {
          node: taskNode(hidden),
          side: "after",
        });
        await moveTask(moving, null, left.id, {
          node: taskNode(visible),
          side: "after",
        });
        await publishAndArchiveHost(fixture);
        const beforeTasks = [
          await taskState(hidden, 404),
          await taskState(visible),
          await taskState(moving),
        ];
        expect(membersIn(await read(), left.id)).toEqual([
          member(hidden, left.id, 0),
          member(visible, left.id, 1),
          member(moving, left.id, 2),
        ]);
        await moveTask(moving, left.id, right.id);
        expect(membersIn(await read(), left.id)).toEqual([
          member(hidden, left.id, 0),
          member(visible, left.id, 1),
        ]);
        await moveTask(moving, right.id, left.id, {
          node: taskNode(visible),
          side: "before",
        });
        await moveTask(visible, left.id, null, {
          node: { type: "group", groupId: right.id },
          side: "before",
        });
        await moveTask(visible, null, left.id);
        const after = await read();
        expect(after.revision).toBe(9);
        expect(after.groups).toEqual([left, right]);
        expect(after.order).toEqual([
          { type: "group", key: right.id, sortOrder: 0 },
          { type: "group", key: left.id, sortOrder: 1 },
        ]);
        expect(membersIn(after, left.id)).toEqual([
          member(visible, left.id, 0),
          member(hidden, left.id, 1),
          member(moving, left.id, 2),
        ]);
        expect(membersIn(after, right.id)).toEqual([]);
        for (const input of [
          {
            node: taskNode(hidden),
            sourceGroupId: left.id,
            groupId: right.id,
            expectedRevision: 9,
          },
          {
            node: taskNode(moving),
            sourceGroupId: left.id,
            groupId: left.id,
            expectedRevision: 9,
            anchor: { node: taskNode(hidden), side: "after" },
          },
        ])
          await expectRejected([input], 404, after);
        const natural = await rpc("admit", [{ tasks: fixture.tasks }]);
        expect(natural.status, JSON.stringify(natural.body)).toBe(200);
        expect(await read()).toEqual(after);
        expect([
          await taskState(hidden, 404),
          await taskState(visible),
          await taskState(moving),
        ]).toEqual(beforeTasks);
        expect(fixture.model.requests).toHaveLength(1);
        expect(fixture.model.requests[0]?.closed).toBe(true);
      });
    }, 90_000); // 受控模型 HTTP、真实归档和隐藏成员完整排序的期限。

    it("真实删除Task后节点及锚点的原移动都返回404，保留其它Task和分组顺序", async () => {
      await withTasks(2, async (fixture) => {
        const removed = taskAt(fixture, 0);
        const retainedTask = taskAt(fixture, 1);
        const beforeRetained = await taskState(retainedTask);
        const left = await createGroup("保留删除后成员的组");
        const right = await createGroup("继续保留的另一组");
        const originalNode = await moveTask(removed, null, left.id);
        const originalAnchor = await moveTask(retainedTask, null, left.id, {
          node: taskNode(removed),
          side: "after",
        });
        await publishAndArchiveHost(fixture);
        const deleted = await organizeHostTask(fixture, "deleteArchivedTask");
        expect(deleted.body.result).toBe(true);
        const after = await read();
        expect(after).toEqual({
          revision: 5,
          groups: [left, right],
          members: [member(retainedTask, left.id, 1)],
          order: [
            { type: "group", key: right.id, sortOrder: 0 },
            { type: "group", key: left.id, sortOrder: 1 },
          ],
        });
        for (let round = 0; round < 2; round++) {
          await expectRejected([originalNode], 404, after);
          await expectRejected([originalAnchor], 404, after);
        }
        await expectRejected(
          [{ ...originalNode, expectedRevision: 5 }],
          404,
          after,
        );
        await expectRejected(
          [{ ...originalAnchor, sourceGroupId: left.id, expectedRevision: 5 }],
          404,
          after,
        );
        for (const path of [
          `/api/code-ui/sessions/${removed.taskId}`,
          `/api/code-ui/tasks/${removed.taskId}/scope`,
        ]) {
          const missing = await http.request(path);
          expect(missing.status, JSON.stringify(missing.body)).toBe(404);
        }
        expect(await taskState(retainedTask)).toEqual(beforeRetained);
        expect(fixture.model.requests).toHaveLength(1);
        expect(fixture.model.requests[0]?.closed).toBe(true);
      });
    }, 90_000); // 真实 Task 删除、原移动墓碑和保留成员读取的期限。
  },
);
