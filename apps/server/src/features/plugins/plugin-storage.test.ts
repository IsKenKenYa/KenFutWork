import { describe, expect, it } from "vitest";

import type { PersistenceService } from "../persistence/types.js";
import { createPluginStorage } from "./plugin-storage.js";

/**
 * 插件存储单测：锁三件事——
 * 1) 每条实例作用域语句都带 `:instance` 谓词（漏写会被持久化缝拒绝）；
 * 2) 本地插件存储按 value_text 原样保存文本；
 * 3) 缺实例/插件 id/键、值非字符串时 fail loud（静默兜底会写错作用域）。
 *
 * 真实 SQL 行为（表结构、冲突更新、删除行数）由真机验收覆盖；这里用记录型 persistence
 * 断言语句形状与参数（与 `execution-mode-store.test.ts` 同一范式）。
 */

interface Call {
  op: "query" | "queryOne" | "execute";
  instanceId?: string;
  sql: string;
  params?: readonly unknown[];
}

function createRecordingPersistence(
  rows: Record<string, unknown>[] = [],
  affected = 1,
) {
  const calls: Call[] = [];
  const makeClient = (instanceId?: string) => ({
    ...(instanceId === undefined ? {} : { instanceId }),
    async query(sql: string, params?: readonly unknown[]) {
      calls.push({
        op: "query",
        ...(instanceId ? { instanceId } : {}),
        sql,
        ...(params ? { params } : {}),
      });
      return rows;
    },
    async queryOne(sql: string, params?: readonly unknown[]) {
      calls.push({
        op: "queryOne",
        ...(instanceId ? { instanceId } : {}),
        sql,
        ...(params ? { params } : {}),
      });
      return rows[0] ?? null;
    },
    async execute(sql: string, params?: readonly unknown[]) {
      calls.push({
        op: "execute",
        ...(instanceId ? { instanceId } : {}),
        sql,
        ...(params ? { params } : {}),
      });
      return affected;
    },
  });
  const persistence = {
    ...makeClient(),
    forInstance: (instanceId: string) => makeClient(instanceId),
  } as unknown as PersistenceService;
  return { persistence, calls };
}

describe("插件存储：语句形状与实例作用域", () => {
  it("set 走实例作用域、语句带 :instance，落库文本与输入一致", async () => {
    const { persistence, calls } = createRecordingPersistence();
    const storage = createPluginStorage({
      persistence,
    });

    await storage.set(
      "instance-1",
      "local__kenfutwork-mihome",
      "session",
      "会话令牌",
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.op).toBe("execute");
    expect(call?.instanceId).toBe("instance-1");
    expect(call?.sql).toContain(":instance");
    expect(call?.sql).toContain(
      "on conflict (instance_id, plugin_id, entry_key)",
    );
    expect(call?.params?.[0]).toBe("local__kenfutwork-mihome");
    expect(call?.params?.[1]).toBe("session");

    const stored = String(call?.params?.[2] ?? "");
    expect(stored).toBe("会话令牌");
    expect(call?.sql).toContain("value_text");
    expect(call?.sql).not.toContain("value_ciphertext");
  });

  it("get 原样返回文本；未存过返回 null（空串与「没有」不混）", async () => {
    const hit = createRecordingPersistence([{ value_text: "" }]);
    const storage = createPluginStorage({
      persistence: hit.persistence,
    });

    await expect(storage.get("instance-1", "plug", "session")).resolves.toBe(
      "",
    );
    const call = hit.calls[0];
    expect(call?.op).toBe("queryOne");
    expect(call?.instanceId).toBe("instance-1");
    expect(call?.sql).toContain(":instance");
    expect(call?.params).toEqual(["plug", "session"]);

    const miss = createRecordingPersistence([]);
    const empty = createPluginStorage({
      persistence: miss.persistence,
    });
    await expect(
      empty.get("instance-1", "plug", "session"),
    ).resolves.toBeNull();
  });

  it("remove 命中返回 true、未命中返回 false，且按插件与键精确删除", async () => {
    const hit = createRecordingPersistence();
    const storage = createPluginStorage({
      persistence: hit.persistence,
    });
    await expect(storage.remove("instance-9", "plug", "k")).resolves.toBe(true);
    expect(hit.calls[0]?.sql).toContain(":instance");
    expect(hit.calls[0]?.params).toEqual(["plug", "k"]);

    const miss = createRecordingPersistence([], 0);
    const zero = createPluginStorage({
      persistence: miss.persistence,
    });
    await expect(zero.remove("instance-1", "plug", "k")).resolves.toBe(false);
  });

  it("keys 只列该插件在该实例的键（按字典序由 SQL 保证）", async () => {
    const { persistence, calls } = createRecordingPersistence([
      { entry_key: "a" },
      { entry_key: "b" },
    ]);
    const storage = createPluginStorage({
      persistence,
    });

    await expect(storage.keys("instance-2", "plug")).resolves.toEqual([
      "a",
      "b",
    ]);
    const call = calls[0];
    expect(call?.op).toBe("query");
    expect(call?.instanceId).toBe("instance-2");
    expect(call?.sql).toContain(":instance");
    expect(call?.sql).toContain("order by entry_key asc");
    expect(call?.params).toEqual(["plug"]);
  });

  it("purgePlugin 走根客户端按 plugin_id 清空（卸载清理全部存储记录）", async () => {
    const { persistence, calls } = createRecordingPersistence();
    const storage = createPluginStorage({
      persistence,
    });

    await expect(storage.purgePlugin("plug")).resolves.toBe(1);
    const call = calls[0];
    expect(call?.op).toBe("execute");
    // 根客户端没有实例作用域，这是唯一允许不带 :instance 的语句
    expect(call?.instanceId).toBeUndefined();
    expect(call?.sql).not.toContain(":instance");
    expect(call?.sql).toContain("where plugin_id = $1");
    expect(call?.params).toEqual(["plug"]);
  });
});

describe("插件存储：入参校验 fail loud", () => {
  function makeStorage() {
    const { persistence } = createRecordingPersistence();
    return createPluginStorage({ persistence });
  }

  it("缺实例（空/空白/非字符串）一律拒绝，不落到任何默认作用域", async () => {
    const storage = makeStorage();
    await expect(storage.get("", "plug", "k")).rejects.toThrow(/缺少实例/);
    await expect(storage.set("   ", "plug", "k", "v")).rejects.toThrow(
      /缺少实例/,
    );
    await expect(
      storage.set(undefined as unknown as string, "plug", "k", "v"),
    ).rejects.toThrow(/缺少实例/);
    await expect(storage.keys("", "plug")).rejects.toThrow(/缺少实例/);
  });

  it("缺插件 id / 缺键 / 值非字符串同样拒绝", async () => {
    const storage = makeStorage();
    await expect(storage.set("instance-1", "", "k", "v")).rejects.toThrow(
      /缺少插件 id/,
    );
    await expect(storage.set("instance-1", "plug", "", "v")).rejects.toThrow(
      /缺少键/,
    );
    await expect(
      storage.set("instance-1", "plug", "k", 42 as unknown as string),
    ).rejects.toThrow(/值必须是字符串/);
    await expect(storage.purgePlugin("")).rejects.toThrow(/缺少插件 id/);
  });

  it("值里有中文/换行/JSON 也能原样存储", async () => {
    const value = JSON.stringify({
      ssecurity: "abc+/=",
      cookie: "a=b; c=d",
      note: "第一行\n第二行",
    });
    const { persistence, calls } = createRecordingPersistence();
    const storage = createPluginStorage({
      persistence,
    });

    await storage.set("instance-1", "plug", "session", value);
    const stored = String(calls[0]?.params?.[2] ?? "");
    expect(stored).toBe(value);
  });
});
