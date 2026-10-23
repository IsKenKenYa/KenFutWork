import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applicationErrorResponseSchema,
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

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

async function createRootTasks(session: Host) {
  const initial = protocol.conversationSnapshotSchema.parse(
    await session.snapshot(),
  );
  const taskIds: string[] = [];
  for (let count = 0; count < 3; count++) {
    const created = await session.stream.rpc("sendConversationCommandV4", [
      {
        projectId: session.projectId,
        workspacePath: session.workspacePath,
        envelope: {
          commandId: randomUUID(),
          clientId: session.clientId,
          sessionId: null,
          type: "createSession",
          payload: {
            workspaceId: session.projectId,
            config: { modelSelection: initial.config.modelSelection },
          },
          issuedAt: Date.now(),
        },
      },
    ]);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const ack = protocol.commandAckSchema.parse(created.body.result);
    expect(ack.status).toBe("accepted");
    if (ack.result?.type !== "createSession")
      throw new Error("创建回执缺少真实Task身份。");
    taskIds.push(ack.result.sessionId);
  }
  return taskIds;
}

async function prepareOrderMaterial(session: Host, database: Client) {
  const hidden = session.sessionId;
  const [visible, one, two] = await createRootTasks(session);
  if (!visible || !one || !two) throw new Error("顺序材料缺少三个根Task。");
  const [leading, trailing] = [one, two].sort().reverse();
  if (!leading || !trailing) throw new Error("顺序材料缺少两个根Task。");
  const rootPaths = new Map([
    [leading, join(session.workspacePath, "A-原先排在前面的目录")],
    [trailing, join(session.workspacePath, "Z-原先排在后面的目录")],
  ]);
  for (const path of rootPaths.values()) await mkdir(path);
  const removed = await createGroup("包含隐藏成员的分组");
  const retained = await createGroup("保持的根分组");
  await database.connect();
  // 仅准备既有成员、归档与顺序材料；操作和结果核验均经过原公开RPC。
  await database.query("begin");
  await database.query(
    `update public.code_task_groups set sort_order=
    case when id=$1 then 2 else 4 end`,
    [removed.id],
  );
  for (const [taskId, groupId, order] of [
    [hidden, removed.id, 40],
    [visible, removed.id, 60],
    [leading, null, 0],
    [trailing, null, 0],
  ]) {
    await database.query(
      `insert into public.code_task_group_members
      (instance_id,task_id,task_kind,group_id,sort_order)
      select instance_id,id,'code',$2,$3 from public.code_ui_sessions where id=$1`,
      [taskId, groupId, order],
    );
  }
  for (const [taskId, path] of rootPaths)
    await database.query(
      "update public.code_ui_sessions set root_directory=$2 where id=$1",
      [taskId, path],
    );
  await database.query(
    "update public.code_ui_sessions set archived=true where id=$1",
    [hidden],
  );
  await database.query("commit");
  return {
    hidden,
    visible,
    leading,
    trailing,
    rootPaths,
    removed,
    retained,
    taskIds: [hidden, visible, leading, trailing],
  };
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原取消分组的真实HTTP与PostgreSQL integration",
  () => {
    it("取消组并重放保持已删除结果，保留其它组且迟到创建和编辑不恢复分组", async () => {
      const creation = {
        creationId: randomUUID(),
        expectedRevision: 0,
        title: "要取消的分组",
      };
      const created = await rpc("save", [creation]);
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const group = codeTaskGroupSchema.parse(created.body.result);
      const edit = { id: group.id, expectedRevision: 1, title: "已编辑的分组" };
      const edited = await rpc("save", [edit]);
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      const retainedResponse = await rpc("save", [
        { creationId: randomUUID(), expectedRevision: 2, title: "保留的分组" },
      ]);
      expect(
        retainedResponse.status,
        JSON.stringify(retainedResponse.body),
      ).toBe(200);
      const retained = codeTaskGroupSchema.parse(retainedResponse.body.result);
      const intent = { id: group.id, expectedRevision: 3 };
      const removed = await rpc("ungroup", [intent]);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(codeUiRpcResponseSchema.parse(removed.body)).toEqual({
        result: null,
      });
      const after = await read();
      expect(after).toEqual({
        revision: 4,
        groups: [retained],
        members: [],
        order: [{ type: "group", key: retained.id, sortOrder: 0 }],
      });
      for (let round = 0; round < 2; round++) {
        const repeated = await rpc("ungroup", [intent]);
        expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
        expect(codeUiRpcResponseSchema.parse(repeated.body)).toEqual(
          removed.body,
        );
        for (const late of [creation, edit, { ...edit, expectedRevision: 4 }]) {
          const rejected = await rpc("save", [late]);
          expect(rejected.status, JSON.stringify(rejected.body)).toBe(404);
          expect(
            applicationErrorResponseSchema.parse(rejected.body).error.code,
          ).toBe("task_group_not_found");
        }
        expect(await read()).toEqual(after);
      }
    }, 90_000); // 独占HTTP、SSE与临时PG的取消、重放和资源关闭期限。

    it("同键并发取消只推进一次修订，拒绝旧观察值与非法参数且不影响保留分组", async () => {
      const removed = await createGroup("并发取消的分组");
      const retained = await createGroup("并发保留的分组");
      const before = await read();
      const intent = { id: removed.id, expectedRevision: before.revision };
      for (const args of [
        [],
        [removed.id],
        [null],
        [{ id: removed.id }],
        [{ ...intent, expectedRevision: -1 }],
        [{ ...intent, expectedRevision: 1.5 }],
        [{ ...intent, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
        [{ ...intent, unexpected: true }],
        [intent, intent],
      ]) {
        const invalid = await rpc("ungroup", args);
        expect(invalid.status, JSON.stringify(invalid.body)).toBe(400);
        expect(await read()).toEqual(before);
      }
      const stale = await rpc("ungroup", [{ ...intent, expectedRevision: 1 }]);
      expect(stale.status, JSON.stringify(stale.body)).toBe(409);
      expect(applicationErrorResponseSchema.parse(stale.body).error.code).toBe(
        "task_group_revision_conflict",
      );
      const responses = await Promise.all([
        rpc("ungroup", [intent]),
        rpc("ungroup", [{ ...intent, id: removed.id.toUpperCase() }]),
      ]);
      for (const response of responses)
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      const after = await read();
      expect(after).toEqual({
        revision: 3,
        groups: [retained],
        members: [],
        order: [{ type: "group", key: retained.id, sortOrder: 0 }],
      });
      for (const input of [
        { id: removed.id, expectedRevision: 3 },
        { id: randomUUID(), expectedRevision: 3 },
      ]) {
        const missing = await rpc("ungroup", [input]);
        expect(missing.status, JSON.stringify(missing.body)).toBe(404);
        expect(
          applicationErrorResponseSchema.parse(missing.body).error.code,
        ).toBe("task_group_not_found");
        expect(await read()).toEqual(after);
      }
      const createdAfter = await createGroup("取消后新建的分组");
      const afterCreate = await read();
      const replay = await rpc("ungroup", [intent]);
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(await read()).toEqual(afterCreate);
      expect(afterCreate.order.map((node) => node.key)).toEqual([
        createdAfter.id,
        retained.id,
      ]);
    }, 90_000);

    it("取消组保留同位置根节点次序，归档隐藏成员按原顺序返根且Task正文目录权限保持", async () => {
      const model = await heldModel();
      let host:
        | Awaited<ReturnType<typeof createCodeSessionFixture>>
        | undefined;
      const database = new Client({ connectionString: http.databaseUrl() });
      try {
        host = await createCodeSessionFixture(model.baseUrl, { client: http });
        const session = host;
        const {
          hidden,
          visible,
          leading,
          trailing,
          rootPaths,
          removed,
          retained,
          taskIds,
        } = await prepareOrderMaterial(session, database);
        const before = await read();
        expect(before.members.map((member) => member.taskId)).toEqual([
          hidden,
          visible,
        ]);
        expect(
          before.order
            .filter((node) => node.type === "task")
            .map((node) => JSON.parse(node.key)[1]),
        ).toEqual([leading, trailing]);
        const paths = async () =>
          Promise.all(
            taskIds.map(async (taskId) => ({
              session: await http.request(`/api/code-ui/sessions/${taskId}`),
              scope: await http.request(`/api/code-ui/tasks/${taskId}/scope`),
            })),
          );
        const taskState = await paths();
        for (const state of taskState) {
          expect(state.session.status, JSON.stringify(state.session.body)).toBe(
            200,
          );
        }
        expect(taskState.map((state) => state.scope.status)).toEqual([
          404, 200, 200, 200,
        ]);
        expect(
          applicationErrorResponseSchema.parse(taskState[0]?.scope.body).error
            .code,
        ).toBe("task_not_found");
        const removedResponse = await rpc("ungroup", [
          { id: removed.id, expectedRevision: before.revision },
        ]);
        expect(
          removedResponse.status,
          JSON.stringify(removedResponse.body),
        ).toBe(200);
        const key = (taskId: string | undefined) =>
          JSON.stringify([
            JSON.stringify([
              session.projectId,
              rootPaths.get(taskId ?? "") ?? session.workspacePath,
            ]),
            taskId,
          ]);
        expect(await read()).toEqual({
          revision: 3,
          groups: [retained],
          members: [],
          order: [
            { type: "task", key: key(leading), sortOrder: 0 },
            { type: "task", key: key(trailing), sortOrder: 1 },
            { type: "task", key: key(hidden), sortOrder: 2 },
            { type: "task", key: key(visible), sortOrder: 3 },
            { type: "group", key: retained.id, sortOrder: 4 },
          ],
        });
        expect(await paths()).toEqual(taskState);
        expect(model.requests).toHaveLength(0);
      } finally {
        await database.end();
        await host?.dispose();
        await model.close();
      }
    }, 90_000); // 真实四个根Task、固定目录和隐藏成员返根的集成期限。
  },
);
