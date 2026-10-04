import { describe, expect, it } from "vitest";

import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createApiTokenRepository } from "./repository.js";

/**
 * api-tokens 仓储（R5-2「外部应用授权」）。
 *
 * 最要紧的一条来自**真机踩坑**：持久化缝要求工作区数据的 SQL 里必须出现 `:workspace` 谓词，
 * 少了它请求会被守卫拒掉（真机 500：「query 缺少 :workspace 谓词」）。所以这里把工作区语句
 * 的谓词钉死——缝会把 `:workspace` 绑成参数（`workspace_id = $N` + 值进 values），
 * 断言就按**绑定后**的形态写。
 */
function createRunner(respond: (text: string) => { rows: unknown[] }) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const runner: PostgresQueryRunner = {
    async query(text, values) {
      calls.push({ text, values });
      return { rowCount: respond(text).rows.length, rows: respond(text).rows };
    },
    async acquire() {
      return {
        query: async (text, values) => {
          calls.push({ text, values });
          return {
            rowCount: respond(text).rows.length,
            rows: respond(text).rows,
          };
        },
        release: () => {},
      };
    },
    async acquireSession() { throw new Error("此查询夹具不提供真实执行宿主会话。"); },
    async end() {},
  };
  return { runner, calls };
}

describe("api-tokens 仓储", () => {
  it("列出与吊销都带 :workspace 谓词（工作区隔离是缝的硬约束）", async () => {
    const { runner, calls } = createRunner(() => ({ rows: [] }));
    const repository = createApiTokenRepository(
      createPersistenceFromRunner(runner),
    );
    await repository.list("ws-1");
    await repository.revoke("ws-1", "tok-1");
    for (const call of calls) {
      // 缝把标记绑成参数后的形态：谓词在 SQL 里、工作区值在 values 里
      expect(call.text).toContain("workspace_id =");
      expect(call.values).toContain("ws-1");
    }
  });

  it("创建：明文哈希与名字按列写入，返回可读记录（不含明文）", async () => {
    const { runner, calls } = createRunner(() => ({
      rows: [
        {
          id: "tok-1",
          name: "CI",
          token_prefix: "kfw_abcd",
          created_at: new Date("2026-09-17T00:00:00.000Z"),
          last_used_at: null,
          revoked_at: null,
        },
      ],
    }));
    const repository = createApiTokenRepository(
      createPersistenceFromRunner(runner),
    );
    const record = await repository.create({
      workspaceId: "ws-1",
      userId: "user-1",
      name: "CI",
      tokenHash: "hash-1",
      tokenPrefix: "kfw_abcd",
    });
    expect(record).toEqual({
      id: "tok-1",
      name: "CI",
      tokenPrefix: "kfw_abcd",
      createdAt: "2026-09-17T00:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    });
    // 落库的是哈希 + 前缀 + 用户 id（前缀本来就是要存的：界面靠它辨认）
    expect(calls[0]?.values).toEqual(
      expect.arrayContaining(["user-1", "CI", "hash-1", "kfw_abcd"]),
    );
  });

  it("令牌换账号：只认未吊销，命中即刷新 last_used_at", async () => {
    const { runner, calls } = createRunner(() => ({
      rows: [
        { user_id: "user-1", email: "u@example.com", raw_user_meta_data: {} },
      ],
    }));
    const repository = createApiTokenRepository(
      createPersistenceFromRunner(runner),
    );
    const account = await repository.findAccountByTokenHash("hash-1");
    expect(account).toEqual({
      userId: "user-1",
      email: "u@example.com",
      userMetaData: {},
    });
    expect(calls[0]?.text).toContain("revoked_at is null");
    expect(calls[0]?.text).toContain("last_used_at = now()");
  });
});
