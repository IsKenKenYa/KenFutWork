import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  codeTaskGroupSchema,
  codeTaskGroupStructureSchema,
} from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { nextHostServiceEvent } from "./host-client.fixture.js";

const isolatedHttp = useCodeUiHttpFixture();

function groupRpc(method: string, args: unknown[] = []) {
  return isolatedHttp.request("/api/code-ui/rpc", {
    service: "task-groups",
    method,
    args,
  });
}

async function readGroups() {
  const response = await groupRpc("read");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskGroupStructureSchema.parse(response.body.result);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原分组创建与编辑的真实 HTTP 与 PostgreSQL integration",
  () => {
    it("稳定创建和编辑后可读回，旧创建重放不覆盖后续名称颜色且不创建项目或Task", async () => {
      const beforeProjects = await isolatedHttp.request("/api/projects");
      expect(beforeProjects.status, JSON.stringify(beforeProjects.body)).toBe(
        200,
      );
      const before = await readGroups();
      expect(before).toEqual({
        revision: 0,
        groups: [],
        members: [],
        order: [],
      });
      const draft = {
        creationId: randomUUID(),
        expectedRevision: before.revision,
        title: "  研发资料  ",
      };
      const response = await groupRpc("save", [draft]);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const created = codeTaskGroupSchema.parse(response.body.result);
      expect(created).toMatchObject({ title: "研发资料", color: "gray" });
      expect(created.updatedAt).toBe(created.createdAt);
      expect(await readGroups()).toEqual({
        revision: 1,
        groups: [created],
        members: [],
        order: [{ type: "group", key: created.id, sortOrder: 0 }],
      });
      const editedResponse = await groupRpc("save", [
        {
          id: created.id,
          expectedRevision: 1,
          title: "资料与设计",
          color: "blue",
        },
      ]);
      expect(editedResponse.status, JSON.stringify(editedResponse.body)).toBe(
        200,
      );
      const edited = codeTaskGroupSchema.parse(editedResponse.body.result);
      expect(edited).toMatchObject({
        id: created.id,
        title: "资料与设计",
        color: "blue",
        createdAt: created.createdAt,
      });
      const current = await readGroups();
      expect(current).toEqual({
        revision: 2,
        groups: [edited],
        members: [],
        order: [{ type: "group", key: created.id, sortOrder: 0 }],
      });
      const replay = await groupRpc("save", [draft]);
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.result).toEqual(created);
      const conflict = await groupRpc("save", [
        { ...draft, title: "另一创建意图" },
      ]);
      expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
      expect(
        applicationErrorResponseSchema.parse(conflict.body).error.code,
      ).toBe("task_group_revision_conflict");
      expect(await readGroups()).toEqual(current);
      expect(await isolatedHttp.request("/api/projects")).toEqual(
        beforeProjects,
      );
    }, 90_000); // 独占 HTTP、SSE 与临时 PostgreSQL 的完整创建、编辑及资源关闭期限。

    it("同键并发创建只产生一个分组，同修订并发编辑只接受一个请求且同值保存保持修订", async () => {
      const draft = {
        creationId: randomUUID(),
        expectedRevision: 0,
        title: "研究🔎与设计",
      };
      const created = await Promise.all([
        groupRpc("save", [draft]),
        groupRpc("save", [draft]),
      ]);
      for (const response of created)
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(created[0]?.body.result).toEqual(created[1]?.body.result);
      const group = codeTaskGroupSchema.parse(created[0]?.body.result);
      const afterCreate = await readGroups();
      expect(afterCreate).toEqual({
        revision: 1,
        groups: [group],
        members: [],
        order: [{ type: "group", key: group.id, sortOrder: 0 }],
      });
      const noChange = await groupRpc("save", [
        { id: group.id, expectedRevision: 1, title: group.title },
      ]);
      expect(noChange.status, JSON.stringify(noChange.body)).toBe(200);
      expect(noChange.body.result).toEqual(group);
      expect(await readGroups()).toEqual(afterCreate);
      const alternatives = [
        { id: group.id, expectedRevision: 1, color: "blue" },
        { id: group.id, expectedRevision: 1, color: "green" },
      ];
      const edits = await Promise.all(
        alternatives.map((input) => groupRpc("save", [input])),
      );
      expect(edits.map((response) => response.status).sort()).toEqual([
        200, 409,
      ]);
      const winnerIndex = edits.findIndex(
        (response) => response.status === 200,
      );
      const winner = codeTaskGroupSchema.parse(edits[winnerIndex]?.body.result);
      const afterEdit = await readGroups();
      expect(afterEdit).toEqual({
        revision: 2,
        groups: [winner],
        members: [],
        order: afterCreate.order,
      });
      const replay = await groupRpc("save", [alternatives[winnerIndex]]);
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.result).toEqual(winner);
      const normalizedReplay = await groupRpc("save", [
        {
          ...draft,
          creationId: draft.creationId.toUpperCase(),
          title: "  研究🔎与设计  ",
          color: "gray",
        },
      ]);
      expect(
        normalizedReplay.status,
        JSON.stringify(normalizedReplay.body),
      ).toBe(200);
      expect(normalizedReplay.body.result).toEqual(group);
      const stale = await groupRpc("save", [
        {
          id: group.id,
          expectedRevision: 1,
          title: winner.title,
          color: winner.color,
        },
      ]);
      expect(stale.status, JSON.stringify(stale.body)).toBe(409);
      expect(await readGroups()).toEqual(afterEdit);
    }, 90_000);

    it("另一条可信连接收到原分组通知并从同一服务读取保存结果", async () => {
      const stream = await isolatedHttp.openCodeStream();
      let frame: unknown;
      let receiveError: unknown;
      let receiving: Promise<void> | undefined;
      try {
        const initialized = await stream.rpc("initializeConversationV4", [
          {
            kind: "clientHello",
            protocolVersion: 3,
            clientId: randomUUID(),
            appVersion: "task-group-notification-test",
            clientKind: "web",
          },
        ]);
        expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
        receiving = nextHostServiceEvent(stream, "broadcast", "onMessage").then(
          (event) => {
            frame = event;
          },
          (error: unknown) => {
            receiveError = error;
          },
        );
        const response = await groupRpc("save", [
          {
            creationId: randomUUID(),
            expectedRevision: 0,
            title: "跨连接分组",
            color: "purple",
          },
        ]);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const saved = codeTaskGroupSchema.parse(response.body.result);
        await vi.waitFor(
          () => {
            if (receiveError) throw receiveError;
            expect(frame).toMatchObject({
              event: "service",
              service: "broadcast",
              name: "onMessage",
              data: { channel: "state:task-groups", payload: {} },
            });
          },
          { timeout: 5_000 },
        ); // 本机 SSE 状态通知的实际等待期限。
        const read = await isolatedHttp.request("/api/code-ui/rpc", {
          connectionId: stream.ready.hello.connectionId,
          service: "task-groups",
          method: "read",
          args: [],
        });
        expect(read.status, JSON.stringify(read.body)).toBe(200);
        expect(codeTaskGroupStructureSchema.parse(read.body.result)).toEqual({
          revision: 1,
          groups: [saved],
          members: [],
          order: [{ type: "group", key: saved.id, sortOrder: 0 }],
        });
      } finally {
        stream.controller.abort();
        await stream.closed;
        await receiving;
      }
    }, 90_000);

    it("非法保存不创建记录或推进修订，后续有效创建仍可使用原观察值", async () => {
      const base = {
        creationId: randomUUID(),
        expectedRevision: 0,
        title: "合法分组",
      };
      const before = await readGroups();
      for (const args of [
        [],
        [null],
        [base, {}],
        [{ ...base, extra: true }],
        [{ ...base, id: randomUUID() }],
        [{ ...base, creationId: "invalid" }],
        [{ ...base, expectedRevision: -1 }],
        [{ ...base, expectedRevision: 0.5 }],
        [{ ...base, expectedRevision: 9007199254740992 }],
        [{ ...base, title: "   " }],
        [{ ...base, title: "测".repeat(201) }],
        [{ ...base, color: "invalid" }],
        [{ ...base, color: null }],
        [{ creationId: base.creationId, title: base.title }],
      ]) {
        const response = await groupRpc("save", args);
        expect(response.status, JSON.stringify(response.body)).toBe(400);
        expect(
          applicationErrorResponseSchema.parse(response.body).error.code,
        ).toBe("invalid_code_ui_request");
        expect(await readGroups()).toEqual(before);
      }
      const valid = await groupRpc("save", [base]);
      expect(valid.status, JSON.stringify(valid.body)).toBe(200);
      const group = codeTaskGroupSchema.parse(valid.body.result);
      expect(await readGroups()).toEqual({
        revision: 1,
        groups: [group],
        members: [],
        order: [{ type: "group", key: group.id, sortOrder: 0 }],
      });
    }, 90_000);

    it("关闭仍在等待真实数据库锁的连接会取消保存，关闭等待查询退出且旧请求不写入", async () => {
      const lock = new Client({ connectionString: isolatedHttp.databaseUrl() });
      const stream = await isolatedHttp.openCodeStream();
      let locked = false;
      let settled = false;
      let saving: ReturnType<typeof groupRpc> | undefined;
      const draft = {
        creationId: randomUUID(),
        expectedRevision: 0,
        title: "关闭中取消的分组",
      };
      try {
        await lock.connect();
        const initialized = await stream.rpc("initializeConversationV4", [
          {
            kind: "clientHello",
            protocolVersion: 3,
            clientId: randomUUID(),
            appVersion: "task-group-close-test",
            clientKind: "web",
          },
        ]);
        expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
        await lock.query("begin");
        locked = true;
        await lock.query(
          "select revision from public.code_task_group_state for update",
        );
        saving = isolatedHttp
          .request("/api/code-ui/rpc", {
            connectionId: stream.ready.hello.connectionId,
            service: "task-groups",
            method: "save",
            args: [draft],
          })
          .then((response) => {
            settled = true;
            return response;
          });
        await vi.waitFor(
          async () => {
            await lock.query("select pg_stat_clear_snapshot()");
            const blocked = await lock.query(
              `select pid from pg_stat_activity where datname=current_database()
            and pid<>pg_backend_pid() and state='active' and wait_event_type='Lock'
            and query ilike '%public.code_task_group_state%'`,
            );
            expect(blocked.rows).toHaveLength(1);
          },
          { timeout: 10_000 },
        ); // 本例真实数据库行锁次序的等待期限。
        stream.controller.abort();
        await stream.closed;
        await vi.waitFor(async () => {
          const closed = await isolatedHttp.request("/api/code-ui/rpc", {
            connectionId: stream.ready.hello.connectionId,
            service: "task-groups",
            method: "read",
            args: [],
          });
          expect(closed.status, JSON.stringify(closed.body)).toBe(404);
        });
        expect(settled).toBe(false);
        await lock.query("rollback");
        locked = false;
        const response = await saving;
        expect(response.status, JSON.stringify(response.body)).toBe(404);
        expect(
          applicationErrorResponseSchema.parse(response.body).error.code,
        ).toBe("code_ui_not_found");
        expect(await readGroups()).toEqual({
          revision: 0,
          groups: [],
          members: [],
          order: [],
        });
        const retried = await groupRpc("save", [draft]);
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        const group = codeTaskGroupSchema.parse(retried.body.result);
        expect(await readGroups()).toEqual({
          revision: 1,
          groups: [group],
          members: [],
          order: [{ type: "group", key: group.id, sortOrder: 0 }],
        });
      } finally {
        if (locked) await lock.query("rollback");
        stream.controller.abort();
        await stream.closed;
        await saving;
        await lock.end();
      }
    }, 90_000);

    it("组已删除后迟到创建与编辑均被原RPC拒绝，保留组和根顺序不变", async () => {
      const draft = {
        creationId: randomUUID(),
        expectedRevision: 0,
        title: "待删除的分组",
      };
      const created = await groupRpc("save", [draft]);
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const group = codeTaskGroupSchema.parse(created.body.result);
      const edit = {
        id: group.id,
        expectedRevision: 1,
        title: "删除前已经编辑的分组",
        color: "orange",
      };
      const edited = await groupRpc("save", [edit]);
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      const retainedResponse = await groupRpc("save", [
        {
          creationId: randomUUID(),
          expectedRevision: 2,
          title: "继续保留的分组",
        },
      ]);
      expect(
        retainedResponse.status,
        JSON.stringify(retainedResponse.body),
      ).toBe(200);
      const retained = codeTaskGroupSchema.parse(retainedResponse.body.result);
      const database = new Client({
        connectionString: isolatedHttp.databaseUrl(),
      });
      try {
        await database.connect();
        // 仅准备已删除条件；取消组的界面与服务仍单独验收。
        const deleted = await database.query(
          "delete from public.code_task_groups where id=$1 returning id",
          [group.id],
        );
        expect(deleted.rows).toEqual([{ id: group.id }]);
      } finally {
        await database.end();
      }
      const afterDelete = await readGroups();
      expect(afterDelete).toEqual({
        revision: 3,
        groups: [retained],
        members: [],
        order: [{ type: "group", key: retained.id, sortOrder: 0 }],
      });
      for (const input of [draft, edit, { ...edit, expectedRevision: 3 }]) {
        const late = await groupRpc("save", [input]);
        expect(late.status, JSON.stringify(late.body)).toBe(404);
        expect(applicationErrorResponseSchema.parse(late.body).error.code).toBe(
          "task_group_not_found",
        );
        expect(await readGroups()).toEqual(afterDelete);
      }
    }, 90_000);
  },
);
