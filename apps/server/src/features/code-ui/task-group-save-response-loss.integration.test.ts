import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  codeTaskGroupStructureSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCommitResponseLossProxy } from "./pg-commit-response-loss.fixture.mjs";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Proxy = Awaited<ReturnType<typeof createCommitResponseLossProxy>>;

async function connectGroupService(fixture: Fixture) {
  const stream = await fixture.client.openCodeStream();
  const initialized = await stream.rpc("initializeConversationV4", [
    {
      kind: "clientHello",
      protocolVersion: 3,
      clientId: randomUUID(),
      appVersion: "task-group-save-response-loss-test",
      clientKind: "web",
    },
  ]);
  expect(initialized.status, JSON.stringify(initialized.body)).toBe(200);
  return (method: string, args: unknown[] = []) =>
    fixture.client.request("/api/code-ui/rpc", {
      connectionId: stream.ready.hello.connectionId,
      service: "task-groups",
      method,
      args,
    });
}

async function readGroups(
  rpc: Awaited<ReturnType<typeof connectGroupService>>,
) {
  const response = await rpc("read");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskGroupStructureSchema.parse(response.body.result);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原分组保存COMMIT回包丢失的真实HTTP与PostgreSQL integration",
  () => {
    it("真实提交后丢失回包只保存一个组，相同创建键重放原结果且冲突不推进修订", async () => {
      let proxy: Proxy | undefined;
      const fixture = await createCodeUiHttpFixture({
        databaseTransport: async (direct) => {
          proxy = await createCommitResponseLossProxy(direct);
          return proxy;
        },
      });
      const failures: unknown[] = [];
      try {
        if (!proxy) throw new Error("分组保存测试未建立独占PG故障代理。");
        const rpc = await connectGroupService(fixture);
        const before = await readGroups(rpc);
        expect(before).toEqual({
          revision: 0,
          groups: [],
          members: [],
          order: [],
        });
        const draft = {
          creationId: randomUUID(),
          expectedRevision: before.revision,
          title: "  分组回包丢失的原创建意图  ",
          color: "blue",
        };
        proxy.arm(draft.creationId, { taskGroupSave: true });
        const unavailable = await rpc("save", [draft]);
        expect(unavailable.status, JSON.stringify(unavailable.body)).toBe(500);
        expect(
          applicationErrorResponseSchema.parse(unavailable.body).error.code,
        ).toBe("code_ui_error");
        expect(proxy.evidence()).toMatchObject({
          injected: {
            commandId: draft.creationId,
            creationId: draft.creationId,
            taskGroupSave: true,
            commitConfirmed: true,
            replySuppressed: true,
          },
        });
        expect(proxy.evidence().observerError).toBeUndefined();
        proxy.restore();
        const after = await readGroups(rpc);
        expect(after.groups).toHaveLength(1);
        const created = after.groups[0];
        if (!created) throw new Error("提交后的公开分组列表缺少创建结果。");
        expect(created).toMatchObject({
          title: "分组回包丢失的原创建意图",
          color: "blue",
        });
        expect(created.updatedAt).toBe(created.createdAt);
        expect(proxy.evidence()).toMatchObject({
          injected: { targetGroupId: created.id },
        });
        expect(after).toEqual({
          revision: 1,
          groups: [created],
          members: [],
          order: [{ type: "group", key: created.id, sortOrder: 0 }],
        });
        for (let replay = 0; replay < 2; replay++) {
          const repeated = await rpc("save", [draft]);
          expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
          expect(repeated.body.result).toEqual(created);
          expect(await readGroups(rpc)).toEqual(after);
        }
        const conflict = await rpc("save", [
          { ...draft, title: "同创建键的另一份内容" },
        ]);
        expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
        expect(conflict.body.error.code).toBe("task_group_revision_conflict");
        expect(await readGroups(rpc)).toEqual(after);
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
        throw new AggregateError(failures, "分组保存丢包验证或清理失败", {
          cause: failures[0],
        });
    }, 90_000); // 独占HTTP、SSE及临时PG的提交故障、公开重放和资源关闭期限。
  },
);
