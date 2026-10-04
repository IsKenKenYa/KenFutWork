import { describe, expect, it } from "vitest";
import type { PersistenceService } from "../persistence/types.js";
import { createCodeUiRepository } from "./repository.js";

describe("恢复代际失败边界", () => {
  it("旧恢复失败只可标记其自身generation，不污染后续scope/关闭动作", async () => {
    const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
    let generation = 3;
    let state = "revoking";
    const persistence = {
      forWorkspace: () => ({
        execute: async (sql: string, params: readonly unknown[]) => {
          statements.push({ sql, params });
          if (
            !sql.includes("scope_generation = $2") ||
            params[1] === generation
          ) {
            state = "failed";
            return 1;
          }
          return 0;
        },
      }),
    } as unknown as PersistenceService;
    const repository = createCodeUiRepository(persistence);
    await repository.failCloseTask("workspace", "task", 2);
    expect(state).toBe("revoking");
    expect(statements[0]?.params).toEqual(["task", 2]);
    expect(statements[0]?.sql).toContain("workspace_id = :workspace");
    await repository.failCloseTask("workspace", "task", 3);
    expect(state).toBe("failed");
    generation = 4;
    state = "revoking";
    await repository.failCloseTask("workspace", "task");
    expect(state).toBe("failed");
  });
});
