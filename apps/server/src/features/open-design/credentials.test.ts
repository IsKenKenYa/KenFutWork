import { describe, expect, it } from "vitest";
import {
  type OpenDesignCredentialCandidate,
  resolveOpenDesignCredentials,
  resolveOpenDesignProtocolVersion,
} from "./credentials.js";

/**
 * OpenDesign 凭证下发（O3 / `OD-4`）的取值逻辑。
 *
 * 重点在两件事：**只放行该放行的实例**，以及**任何失败路径都不泄漏 Key 明文**
 * （§8 风险 6：凭证禁入面板 URL / query / 日志——错误消息同样算出口）。
 */

const DEEPSEEK: OpenDesignCredentialCandidate = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "DeepSeek",
  protocol: "openai-compatible",
  baseUrl: "https://api.deepseek.com/",
  enabled: true,
  hasCredential: true,
};

const OPENAI: OpenDesignCredentialCandidate = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "OpenAI",
  protocol: "openai-compatible",
  baseUrl: "https://api.openai.com",
  enabled: true,
  hasCredential: true,
};

const keys = new Map([
  [DEEPSEEK.id, "sk-deepseek-secret"],
  [OPENAI.id, "sk-openai-secret"],
]);
const readKey = async (providerId: string) => keys.get(providerId) ?? null;

describe("resolveOpenDesignCredentials", () => {
  it("启用且有 Key 的实例全部下发；apiBase 去尾斜杠", async () => {
    const result = await resolveOpenDesignCredentials({
      instances: [DEEPSEEK, OPENAI],
      readKey,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([
      {
        providerId: DEEPSEEK.id,
        name: "DeepSeek",
        protocol: "openai-compatible",
        apiBase: "https://api.deepseek.com",
        apiKey: "sk-deepseek-secret",
      },
      {
        providerId: OPENAI.id,
        name: "OpenAI",
        protocol: "openai-compatible",
        apiBase: "https://api.openai.com",
        apiKey: "sk-openai-secret",
      },
    ]);
  });

  it("停用的 / 没配 Key 的实例不下发（不把不可用的东西递给 daemon）", async () => {
    const result = await resolveOpenDesignCredentials({
      instances: [
        { ...DEEPSEEK, enabled: false },
        { ...OPENAI, hasCredential: false },
      ],
      readKey,
    });
    expect(result).toEqual({
      ok: false,
      status: 404,
      message: expect.stringContaining("供应商设置"),
    });
  });

  it("没有任何实例 → 404 可读原因（不摆空清单）", async () => {
    const result = await resolveOpenDesignCredentials({
      instances: [],
      readKey,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(result.message).toContain("API Key");
  });

  it("候选实例的 Key 读不到 → 409 fail loud，消息不含 Key 明文", async () => {
    // 模拟：DB 说配了 Key，但凭据文件里没有（外部清掉 / 写坏）。
    const result = await resolveOpenDesignCredentials({
      instances: [DEEPSEEK],
      readKey: async () => null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.message).toContain("DeepSeek");
    // 脱敏红线：失败消息里不允许出现凭据文件的任何内容线索
    expect(result.message).not.toContain("sk-");
    expect(result.message).not.toContain("byok");
    expect(result.message).not.toContain("credentials");
  });

  it("Key 是空串 → 同样 409（空串不是有效 Key）", async () => {
    const result = await resolveOpenDesignCredentials({
      instances: [DEEPSEEK],
      readKey: async () => "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
  });

  it("地址非 http(s) → 409 fail loud；消息不含 Key", async () => {
    const result = await resolveOpenDesignCredentials({
      instances: [{ ...DEEPSEEK, baseUrl: "ftp://127.0.0.1:9000" }],
      readKey: async () => "sk-should-never-be-used",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.message).toContain("http(s)");
    expect(result.message).not.toContain("sk-");
  });

  it("地址缺省 → apiBase 为 null（CLI 用官方默认端点），不是报错", async () => {
    const result = await resolveOpenDesignCredentials({
      instances: [{ ...DEEPSEEK, baseUrl: undefined }],
      readKey,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]?.apiBase).toBeNull();
    expect(result.entries[0]?.apiKey).toBe("sk-deepseek-secret");
  });

  it("一个实例读 Key 失败即整体失败（不給半个清单——partial 比没有更危险）", async () => {
    const result = await resolveOpenDesignCredentials({
      instances: [DEEPSEEK, OPENAI],
      readKey: async (providerId) =>
        providerId === OPENAI.id ? null : (keys.get(providerId) ?? null),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    // 失败时绝不夹带任何一条 key
    expect(JSON.stringify(result)).not.toContain("sk-deepseek");
  });
});

describe("resolveOpenDesignProtocolVersion", () => {
  it("缺省按当前版本受理；显式当前版本也受理", () => {
    expect(resolveOpenDesignProtocolVersion(undefined).ok).toBe(true);
    expect(resolveOpenDesignProtocolVersion("v1")).toEqual({
      ok: true,
      version: "v1",
    });
  });

  it("显式别的版本 → 拒（版本协商不过就不下发凭证）", () => {
    expect(resolveOpenDesignProtocolVersion("v2").ok).toBe(false);
    expect(resolveOpenDesignProtocolVersion("").ok).toBe(false);
  });
});
