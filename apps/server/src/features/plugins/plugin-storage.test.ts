import { describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
} from "../model-providers/secret-store.js";
import type { PersistenceService } from "../persistence/types.js";
import { createPluginStorage } from "./plugin-storage.js";

/**
 * 插件存储单测：锁三件事——
 * 1) 每条工作区作用域语句都带 `:workspace` 谓词（漏写会被持久化缝拒绝，那是运行期才炸的错）；
 * 2) 落库的是**密文**（BYOK 同一条红线：值不落明文）；
 * 3) 缺工作区/插件 id/键、值非字符串时 fail loud（静默兜底会写错作用域，比报错糟得多）。
 *
 * 真实 SQL 行为（表结构、冲突更新、删除行数）由真机验收覆盖；这里用记录型 persistence
 * 断言语句形状与参数（与 `execution-mode-store.test.ts` 同一范式）。
 */

interface Call {
  op: "query" | "queryOne" | "execute";
  workspaceId?: string;
  sql: string;
  params?: readonly unknown[];
}

function createRecordingPersistence(
  rows: Record<string, unknown>[] = [],
  affected = 1,
) {
  const calls: Call[] = [];
  const makeClient = (workspaceId?: string) => ({
    ...(workspaceId === undefined ? {} : { workspaceId }),
    async query(sql: string, params?: readonly unknown[]) {
      calls.push({
        op: "query",
        ...(workspaceId ? { workspaceId } : {}),
        sql,
        ...(params ? { params } : {}),
      });
      return rows;
    },
    async queryOne(sql: string, params?: readonly unknown[]) {
      calls.push({
        op: "queryOne",
        ...(workspaceId ? { workspaceId } : {}),
        sql,
        ...(params ? { params } : {}),
      });
      return rows[0] ?? null;
    },
    async execute(sql: string, params?: readonly unknown[]) {
      calls.push({
        op: "execute",
        ...(workspaceId ? { workspaceId } : {}),
        sql,
        ...(params ? { params } : {}),
      });
      return affected;
    },
  });
  const persistence = {
    ...makeClient(),
    forWorkspace: (workspaceId: string) => makeClient(workspaceId),
  } as unknown as PersistenceService;
  return { persistence, calls };
}

/** 真实密文（走 secret-store 的 AES-256-GCM），证实存储层确实复用了凭证缝的加密。 */
const credentialEnv = { credentialSecret: "test-credential-secret" };

function realCipher() {
  return {
    encrypt: (plaintext: string) => encryptSecret(credentialEnv, plaintext),
    decrypt: (ciphertext: string) => decryptSecret(credentialEnv, ciphertext),
  };
}

describe("插件存储：语句形状与工作区作用域", () => {
  it("set 走工作区作用域、语句带 :workspace，落库值是密文且可解回明文", async () => {
    const { persistence, calls } = createRecordingPersistence();
    const storage = createPluginStorage({
      persistence,
      cipher: realCipher(),
    });

    await storage.set(
      "ws-1",
      "local__kenfutwork-mihome",
      "session",
      "会话令牌",
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.op).toBe("execute");
    expect(call?.workspaceId).toBe("ws-1");
    expect(call?.sql).toContain(":workspace");
    expect(call?.sql).toContain(
      "on conflict (workspace_id, plugin_id, entry_key)",
    );
    expect(call?.params?.[0]).toBe("local__kenfutwork-mihome");
    expect(call?.params?.[1]).toBe("session");

    const stored = String(call?.params?.[2] ?? "");
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored).not.toContain("会话令牌");
    expect(decryptSecret(credentialEnv, stored)).toBe("会话令牌");
  });

  it("get 解密回明文；未存过返回 null（空串与「没有」不混）", async () => {
    const hit = createRecordingPersistence([
      { value_ciphertext: encryptSecret(credentialEnv, "") },
    ]);
    const storage = createPluginStorage({
      persistence: hit.persistence,
      cipher: realCipher(),
    });

    await expect(storage.get("ws-1", "plug", "session")).resolves.toBe("");
    const call = hit.calls[0];
    expect(call?.op).toBe("queryOne");
    expect(call?.workspaceId).toBe("ws-1");
    expect(call?.sql).toContain(":workspace");
    expect(call?.params).toEqual(["plug", "session"]);

    const miss = createRecordingPersistence([]);
    const empty = createPluginStorage({
      persistence: miss.persistence,
      cipher: realCipher(),
    });
    await expect(empty.get("ws-1", "plug", "session")).resolves.toBeNull();
  });

  it("remove 命中返回 true、未命中返回 false，且按插件与键精确删除", async () => {
    const hit = createRecordingPersistence();
    const storage = createPluginStorage({
      persistence: hit.persistence,
      cipher: realCipher(),
    });
    await expect(storage.remove("ws-9", "plug", "k")).resolves.toBe(true);
    expect(hit.calls[0]?.sql).toContain(":workspace");
    expect(hit.calls[0]?.params).toEqual(["plug", "k"]);

    const miss = createRecordingPersistence([], 0);
    const zero = createPluginStorage({
      persistence: miss.persistence,
      cipher: realCipher(),
    });
    await expect(zero.remove("ws-1", "plug", "k")).resolves.toBe(false);
  });

  it("keys 只列该插件在该工作区的键（按字典序由 SQL 保证）", async () => {
    const { persistence, calls } = createRecordingPersistence([
      { entry_key: "a" },
      { entry_key: "b" },
    ]);
    const storage = createPluginStorage({
      persistence,
      cipher: realCipher(),
    });

    await expect(storage.keys("ws-2", "plug")).resolves.toEqual(["a", "b"]);
    const call = calls[0];
    expect(call?.op).toBe("query");
    expect(call?.workspaceId).toBe("ws-2");
    expect(call?.sql).toContain(":workspace");
    expect(call?.sql).toContain("order by entry_key asc");
    expect(call?.params).toEqual(["plug"]);
  });

  it("purgePlugin 走根客户端按 plugin_id 清空（卸载是跨工作区的实例级动作）", async () => {
    const { persistence, calls } = createRecordingPersistence();
    const storage = createPluginStorage({
      persistence,
      cipher: realCipher(),
    });

    await expect(storage.purgePlugin("plug")).resolves.toBe(1);
    const call = calls[0];
    expect(call?.op).toBe("execute");
    // 根客户端没有工作区作用域，这是**唯一**允许不带 :workspace 的语句
    expect(call?.workspaceId).toBeUndefined();
    expect(call?.sql).not.toContain(":workspace");
    expect(call?.sql).toContain("where plugin_id = $1");
    expect(call?.params).toEqual(["plug"]);
  });
});

describe("插件存储：入参校验 fail loud", () => {
  function makeStorage() {
    const { persistence } = createRecordingPersistence();
    return createPluginStorage({ persistence, cipher: realCipher() });
  }

  it("缺工作区（空/空白/非字符串）一律拒绝，不落到任何默认作用域", async () => {
    const storage = makeStorage();
    await expect(storage.get("", "plug", "k")).rejects.toThrow(/缺少工作区/);
    await expect(storage.set("   ", "plug", "k", "v")).rejects.toThrow(
      /缺少工作区/,
    );
    await expect(
      storage.set(undefined as unknown as string, "plug", "k", "v"),
    ).rejects.toThrow(/缺少工作区/);
    await expect(storage.keys("", "plug")).rejects.toThrow(/缺少工作区/);
  });

  it("缺插件 id / 缺键 / 值非字符串同样拒绝", async () => {
    const storage = makeStorage();
    await expect(storage.set("ws-1", "", "k", "v")).rejects.toThrow(
      /缺少插件 id/,
    );
    await expect(storage.set("ws-1", "plug", "", "v")).rejects.toThrow(
      /缺少键/,
    );
    await expect(
      storage.set("ws-1", "plug", "k", 42 as unknown as string),
    ).rejects.toThrow(/值必须是字符串/);
    await expect(storage.purgePlugin("")).rejects.toThrow(/缺少插件 id/);
  });

  it("值里有中文/换行/JSON 也能原样往返（密文按 utf8 编码）", async () => {
    const value = JSON.stringify({
      ssecurity: "abc+/=",
      cookie: "a=b; c=d",
      note: "第一行\n第二行",
    });
    const { persistence, calls } = createRecordingPersistence();
    const storage = createPluginStorage({
      persistence,
      cipher: realCipher(),
    });

    await storage.set("ws-1", "plug", "session", value);
    const stored = String(calls[0]?.params?.[2] ?? "");
    expect(decryptSecret(credentialEnv, stored)).toBe(value);
  });
});
