import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  type CodeTaskGroupTaskRef,
  codeTaskGroupSchema,
  codeTaskGroupStructureSchema,
  codeUiRpcResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const http = useCodeUiHttpFixture();
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

function rpc(method: string, args: unknown = []) {
  return http.request("/api/code-ui/rpc", {
    service: "task-groups",
    method,
    args,
  });
}

async function accepted(method: string, args: unknown[] = []) {
  const response = await rpc(method, args);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeUiRpcResponseSchema.parse(response.body).result;
}

async function read() {
  return codeTaskGroupStructureSchema.parse(await accepted("read"));
}

async function rejected(args: unknown, status: number, code: string) {
  const response = await rpc("admit", args);
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(applicationErrorResponseSchema.parse(response.body).error.code).toBe(
    code,
  );
}

async function admit(input: unknown) {
  expect(await accepted("admit", [input])).toBeNull();
}

async function createGroup(title: string) {
  return codeTaskGroupSchema.parse(
    await accepted("save", [
      {
        creationId: randomUUID(),
        expectedRevision: (await read()).revision,
        title,
      },
    ]),
  );
}

function taskReference(
  host: Host,
  taskId = host.sessionId,
): CodeTaskGroupTaskRef {
  return {
    hostId: "local",
    taskId,
    workspacePath: host.workspacePath,
    workspaceIdentity: JSON.stringify([host.projectId, host.workspacePath]),
  };
}

function rootTask(task: CodeTaskGroupTaskRef, sortOrder: number) {
  return {
    type: "task",
    key: JSON.stringify([task.workspaceIdentity, task.taskId]),
    sortOrder,
  };
}

async function createRootTask(host: Host) {
  const snapshot = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  const response = await host.stream.rpc("sendConversationCommandV4", [
    {
      projectId: host.projectId,
      workspacePath: host.workspacePath,
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: host.projectId,
          config: { modelSelection: snapshot.config.modelSelection },
        },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const ack = protocol.commandAckSchema.parse(
    codeUiRpcResponseSchema.parse(response.body).result,
  );
  expect(ack.status).toBe("accepted");
  if (ack.result?.type !== "createSession")
    throw new Error("创建回执缺少真实Task身份。");
  return taskReference(host, ack.result.sessionId);
}

async function resources(tasks: CodeTaskGroupTaskRef[]) {
  return Promise.all(
    tasks.map(async (task) => {
      const session = await http.request(
        `/api/code-ui/sessions/${task.taskId}`,
      );
      const scope = await http.request(
        `/api/code-ui/tasks/${task.taskId}/scope`,
      );
      expect(session.status, JSON.stringify(session.body)).toBe(200);
      expect(scope.status, JSON.stringify(scope.body)).toBe(200);
      return {
        snapshot: protocol.conversationSnapshotSchema.parse(
          session.body.snapshot,
        ),
        scope: scope.body,
      };
    }),
  );
}

async function markUserOrganized(task: CodeTaskGroupTaskRef) {
  const database = new Client({ connectionString: http.databaseUrl() });
  try {
    await database.connect();
    // 仅准备已有成员的人工整理标记；操作结果通过公开 read 验证。
    const prepared = await database.query(
      `update public.code_task_group_members set user_organized=true
        where task_id=$1 and task_kind='code'
          and instance_id=(select instance_id from public.code_ui_sessions where id=$1)`,
      [task.taskId],
    );
    expect(prepared.rowCount).toBe(1);
  } finally {
    await database.end();
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原首次Task登记的参数、顺序与创建归属HTTP和PostgreSQL integration",
  () => {
    it("严格校验参数和真实身份，拒绝旧地址且合法重复引用只登记一次", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, { client: http });
        const task = taskReference(host);
        const before = { revision: 0, groups: [], members: [], order: [] };
        expect(await read()).toEqual(before);
        const placement = {
          task,
          groupId: null,
          creationId: task.taskId,
        };
        for (const args of [
          null,
          {},
          [],
          [null],
          [{ tasks: "invalid" }],
          [{ tasks: [task], unexpected: true }],
          [{ tasks: [{ ...task, unexpected: true }] }],
          [{ tasks: [{ ...task, hostId: "remote" }] }],
          [{ tasks: [{ ...task, workspacePath: "" }] }],
          [{ tasks: [{ ...task, workspaceIdentity: "" }] }],
          [{ tasks: [task, { ...task, workspacePath: "/old-task" }] }],
          [{ tasks: [task, { ...task, workspaceIdentity: "old-project" }] }],
          [{ tasks: [], placement }],
          [{ tasks: [task], placement: { ...placement, unexpected: true } }],
          [{ tasks: [task] }, { tasks: [task] }],
        ]) {
          await rejected(args, 400, "invalid_code_ui_request");
          expect(await read()).toEqual(before);
        }
        for (const stale of [
          { ...task, workspacePath: `${task.workspacePath}/old` },
          {
            ...task,
            workspaceIdentity: JSON.stringify([
              randomUUID(),
              task.workspacePath,
            ]),
          },
        ]) {
          await rejected(
            [{ tasks: [stale] }],
            409,
            "task_group_revision_conflict",
          );
          expect(await read()).toEqual(before);
        }
        const missing = { ...task, taskId: randomUUID() };
        await admit({ tasks: [missing] });
        expect(await read()).toEqual(before);
        await rejected(
          [
            {
              tasks: [missing],
              placement: {
                task: missing,
                groupId: null,
                creationId: missing.taskId,
              },
            },
          ],
          404,
          "code_ui_not_found",
        );
        expect(await read()).toEqual(before);
        await admit({
          tasks: [task, { ...task, taskId: task.taskId.toUpperCase() }, task],
        });
        expect(await read()).toEqual({
          revision: 1,
          groups: [],
          members: [],
          order: [rootTask(task, 0)],
        });
        expect(model.requests).toHaveLength(0);
      } finally {
        await host?.dispose();
        await model.close();
      }
    }, 90_000); // 独占HTTP、SSE、临时PG及真实Task的参数检查和关闭期限。

    it("批量登记按真实创建时间由新到旧置顶，混合重放只增加新Task并推进一次修订", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, { client: http });
        const a = taskReference(host);
        const b = await createRootTask(host);
        const c = await createRootTask(host);
        const group = await createGroup("批量登记保留的分组");
        const originalResources = await resources([a, b, c]);
        await admit({ tasks: [b, a, c] });
        const registered = {
          revision: 2,
          groups: [group],
          members: [],
          order: [
            rootTask(c, 0),
            rootTask(b, 1),
            rootTask(a, 2),
            { type: "group", key: group.id, sortOrder: 3 },
          ],
        };
        expect(await read()).toEqual(registered);
        await admit({ tasks: [c, a, b] });
        expect(await read()).toEqual(registered);
        const d = await createRootTask(host);
        expect(await read()).toEqual(registered);
        await admit({ tasks: [b, d, c, a, d] });
        expect(await read()).toEqual({
          revision: 3,
          groups: [group],
          members: [],
          order: [
            rootTask(d, 0),
            rootTask(c, 1),
            rootTask(b, 2),
            rootTask(a, 3),
            { type: "group", key: group.id, sortOrder: 4 },
          ],
        });
        expect(await resources([a, b, c])).toEqual(originalResources);
        expect(model.requests).toHaveLength(0);
      } finally {
        await host?.dispose();
        await model.close();
      }
    }, 90_000); // 真实四个根Task的创建、批量登记、资源保持和关闭期限。

    it("人工整理在先时首次placement只消费创建意图，新增组后重放保留原位置", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, { client: http });
        const task = taskReference(host);
        await admit({ tasks: [task] });
        const a = await createGroup("A分组");
        const b = await createGroup("B分组");
        await markUserOrganized(task);
        const organized = {
          revision: 3,
          groups: [a, b],
          members: [],
          order: [
            { type: "group", key: b.id, sortOrder: 0 },
            { type: "group", key: a.id, sortOrder: 1 },
            rootTask(task, 2),
          ],
        };
        expect(await read()).toEqual(organized);
        const intent = {
          tasks: [task],
          placement: { task, groupId: a.id, creationId: task.taskId },
        };
        await admit(intent);
        expect(await read()).toEqual(organized);
        const c = await createGroup("C分组");
        const afterCreate = {
          revision: 4,
          groups: [a, b, c],
          members: [],
          order: [
            { type: "group", key: c.id, sortOrder: 0 },
            { type: "group", key: b.id, sortOrder: 1 },
            { type: "group", key: a.id, sortOrder: 2 },
            rootTask(task, 3),
          ],
        };
        expect(await read()).toEqual(afterCreate);
        await admit(intent);
        expect(await read()).toEqual(afterCreate);
        expect(model.requests).toHaveLength(0);
      } finally {
        await host?.dispose();
        await model.close();
      }
    }, 90_000); // 真实人工整理标记、创建意图消费和历史重放的独占集成期限。

    it("目标组消失后新Task首次placement置于根顶部，重放不恢复组且保持Task权限", async () => {
      const model = await heldModel();
      let host: Host | undefined;
      try {
        const group = await createGroup("已取消的目标分组");
        expect(
          await accepted("ungroup", [{ id: group.id, expectedRevision: 1 }]),
        ).toBeNull();
        expect(await read()).toEqual({
          revision: 2,
          groups: [],
          members: [],
          order: [],
        });
        host = await createCodeSessionFixture(model.baseUrl, { client: http });
        const task = taskReference(host);
        const originalResources = await resources([task]);
        const intent = {
          tasks: [task],
          placement: { task, groupId: group.id, creationId: task.taskId },
        };
        await admit(intent);
        const after = {
          revision: 3,
          groups: [],
          members: [],
          order: [rootTask(task, 0)],
        };
        expect(await read()).toEqual(after);
        for (let replay = 0; replay < 2; replay++) {
          await admit(intent);
          expect(await read()).toEqual(after);
        }
        expect(await resources([task])).toEqual(originalResources);
        expect(model.requests).toHaveLength(0);
      } finally {
        await host?.dispose();
        await model.close();
      }
    }, 90_000); // 删除目标组后的真实新Task登记、重复接纳与资源保持期限。
  },
);
