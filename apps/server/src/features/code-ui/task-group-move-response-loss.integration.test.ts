import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  type CodeTaskGroupStructure,
  codeTaskGroupSchema,
  codeTaskGroupStructureSchema,
  codeUiRpcResponseSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCommitResponseLossProxy } from "./pg-commit-response-loss.fixture.mjs";

type Proxy = Awaited<ReturnType<typeof createCommitResponseLossProxy>>;
type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type GroupConnection = Awaited<ReturnType<typeof connectGroups>>;
type MoveMaterial = Awaited<ReturnType<typeof prepareMoveMaterial>>;

async function connectGroups(fixture: Fixture) {
  const stream = await fixture.client.openCodeStream();
  const initialized = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: 3,
      clientId: randomUUID(),
      appVersion: "task-group-move-response-loss-test",
      clientKind: "web",
    },
  ]);
  expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
  const rpc = (method: string, args: unknown[] = []) =>
    fixture.client.request("/api/code-ui/rpc", {
      connectionId: stream.ready.hello.connectionId,
      service: "task-groups",
      method,
      args,
    });
  const read = async () => {
    const response = await rpc("read");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return codeTaskGroupStructureSchema.parse(response.body.result);
  };
  return { rpc, read };
}

async function prepareMoveMaterial({ rpc, read }: GroupConnection) {
  const groups = [];
  for (const title of ["提交后保留的分组", "本次移动的分组"]) {
    const saved = await rpc("save", [
      {
        creationId: randomUUID(),
        expectedRevision: (await read()).revision,
        title,
      },
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    groups.push(codeTaskGroupSchema.parse(saved.body.result));
  }
  const [first, second] = groups;
  if (!first || !second) throw new Error("公开分组创建缺少结果。");
  const intent = {
    node: { type: "group", groupId: second.id },
    sourceGroupId: null,
    groupId: null,
    expectedRevision: 2,
    anchor: { node: { type: "group", groupId: first.id }, side: "after" },
  };
  const key = JSON.stringify(["group", second.id, 2]);
  return { first, second, intent, key };
}

async function verifyMoveReplays(
  { rpc, read }: GroupConnection,
  { intent, second }: MoveMaterial,
  after: CodeTaskGroupStructure,
) {
  for (let repeat = 0; repeat < 2; repeat++) {
    const replay = await rpc("move", [intent]);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(codeUiRpcResponseSchema.parse(replay.body)).toEqual({
      result: null,
    });
    expect(await read()).toEqual(after);
  }
  const concurrent = await Promise.all([
    rpc("move", [intent]),
    rpc("move", [intent]),
    rpc("move", [
      {
        ...intent,
        node: { ...intent.node, groupId: second.id.toUpperCase() },
      },
    ]),
  ]);
  for (const response of concurrent)
    expect(response.status, JSON.stringify(response.body)).toBe(200);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "分组移动提交回包丢失的真实 HTTP 与 PostgreSQL integration",
  () => {
    it("真实提交后读取唯一顺序，原意图连续及并发重放保持修订，异参冲突且删除后不恢复", async () => {
      let proxy: Proxy | undefined;
      const fixture = await createCodeUiHttpFixture({
        databaseTransport: async (direct) => {
          proxy = await createCommitResponseLossProxy(direct);
          return proxy;
        },
      });
      const failures: unknown[] = [];
      try {
        if (!proxy) throw new Error("分组移动未建立独占 PG 故障代理。");
        const connection = await connectGroups(fixture);
        const { rpc, read } = connection;
        const material = await prepareMoveMaterial(connection);
        const { first, second, intent, key } = material;
        proxy.arm(key, { taskGroupMove: true });
        const unavailable = await rpc("move", [intent]);
        expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(500);
        expect(
          applicationErrorResponseSchema.parse(unavailable.body).error.code,
        ).toBe("code_ui_error");
        expect(proxy.evidence()).toMatchObject({
          injected: {
            commandId: key,
            taskGroupMove: true,
            nodeType: "group",
            nodeId: second.id,
            commitConfirmed: true,
            replySuppressed: true,
          },
        });
        expect(proxy.evidence().observerError).toBeUndefined();
        proxy.restore();
        const after = await read();
        expect(after).toEqual({
          revision: 3,
          groups: [first, second],
          members: [],
          order: [
            { type: "group", key: first.id, sortOrder: 0 },
            { type: "group", key: second.id, sortOrder: 1 },
          ],
        });
        await verifyMoveReplays(connection, material, after);
        const conflict = await rpc("move", [{ ...intent, anchor: undefined }]);
        expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
        expect(
          applicationErrorResponseSchema.parse(conflict.body).error.code,
        ).toBe("task_group_revision_conflict");
        expect(await read()).toEqual(after);
        const removed = await rpc("ungroup", [
          { id: first.id, expectedRevision: 3 },
        ]);
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        const retired = await read();
        expect(retired).toEqual({
          revision: 4,
          groups: [second],
          members: [],
          order: [{ type: "group", key: second.id, sortOrder: 0 }],
        });
        const late = await rpc("move", [intent]);
        expect(late.status, JSON.stringify(late.body)).toBe(404);
        expect(applicationErrorResponseSchema.parse(late.body).error.code).toBe(
          "code_ui_not_found",
        );
        expect(await read()).toEqual(retired);
        expect(proxy.evidence().observerError).toBeUndefined();
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await fixture.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "分组移动丢包验证或清理失败", {
          cause: failures[0],
        });
    }, 90_000); // 独占真实 HTTP、SSE、PG 提交故障与资源关闭的期限。
  },
);
