import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareHarnessTask } from "../agent-runs/test-harness.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createExecutionModeService } from "./execution-mode-service.js";
import { createExecutionModeStore } from "./execution-mode-store.js";

const enabled = process.env.KENFUTWORK_HARNESS_TEST_PG === "1";

describe.skipIf(!enabled)("执行模式Scoped缓存真实库 integration", () => {
  it("已暖模式缓存仍按当前实例查询，foreign hydrate不能读取或覆盖owner模式", async () => {
    const database = await createTaskWorkDatabase();
    try {
      const { scope, threadId } = await prepareHarnessTask(database);
      const foreign = { instanceId: randomUUID() };
      const service = createExecutionModeService({
        store: createExecutionModeStore(database.persistence),
      });
      const owner = { instanceId: scope.instanceId };
      await service.activate(threadId, "plan", owner);
      expect(await service.hydrate(threadId, owner)).toBe("plan");
      expect(
        await service.hydrate(threadId, { instanceId: foreign.instanceId }),
      ).toBe("agent");
      expect(service.getMode(threadId)).toBe("plan");
      expect(await service.lookup(threadId, owner)).toEqual({
        exists: true,
        mode: "plan",
      });
    } finally {
      await database.close();
    }
  }, 90_000);
  it("持久模式写入真实失败时不提前改变已激活模式，修复后可继续激活", async () => {
    const database = await createTaskWorkDatabase();
    try {
      const { scope, threadId } = await prepareHarnessTask(database);
      const owner = { instanceId: scope.instanceId };
      const service = createExecutionModeService({
        store: createExecutionModeStore(database.persistence),
      });
      await service.activate(threadId, "plan", owner);
      // 只在本案独占集群注入DB写拒绝，不修改历史迁移。
      await database.persistence.execute(
        `create function public.reject_test_execution_mode() returns trigger language plpgsql as $$ begin if new.execution_mode is distinct from old.execution_mode then raise exception '测试模式写入失败'; end if; return new; end $$`,
      );
      await database.persistence.execute(
        "create trigger reject_test_execution_mode before update on public.chat_sessions for each row execute function public.reject_test_execution_mode()",
      );
      await expect(service.activate(threadId, "solo", owner)).rejects.toThrow(
        "测试模式写入失败",
      );
      expect(service.getMode(threadId)).toBe("plan");
      expect(await service.lookup(threadId, owner)).toEqual({
        exists: true,
        mode: "plan",
      });
      await database.persistence.execute(
        "drop trigger reject_test_execution_mode on public.chat_sessions",
      );
      await service.activate(threadId, "solo", owner);
      expect(service.getMode(threadId)).toBe("solo");
      expect(
        await createExecutionModeService({
          store: createExecutionModeStore(database.persistence),
        }).hydrate(threadId, owner),
      ).toBe("solo");
    } finally {
      await database.close();
    }
  }, 90_000);
  it("foreign Scoped activate不得用零行写入污染owner已激活策略", async () => {
    const database = await createTaskWorkDatabase();
    try {
      const { scope, threadId } = await prepareHarnessTask(database);
      const foreign = { instanceId: randomUUID() };
      const owner = { instanceId: scope.instanceId };
      const service = createExecutionModeService({
        store: createExecutionModeStore(database.persistence),
      });
      await service.activate(threadId, "plan", owner);
      await expect(
        service.activate(threadId, "solo", { instanceId: foreign.instanceId }),
      ).rejects.toThrow("不属于当前实例");
      expect(service.getMode(threadId)).toBe("plan");
      expect(await service.lookup(threadId, owner)).toEqual({
        exists: true,
        mode: "plan",
      });
    } finally {
      await database.close();
    }
  }, 90_000);
});
