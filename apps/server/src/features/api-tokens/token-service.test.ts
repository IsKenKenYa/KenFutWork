import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../auth/types.js";
import { hashApiToken } from "./repository.js";
import {
  API_TOKEN_PREFIX,
  createApiTokenService,
  generateApiToken,
  parseApiTokenHeader,
} from "./token-service.js";

/**
 * 外部应用访问令牌（R5-2「外部应用授权」）。
 *
 * 红线四条里这条文件锁三条：明文只回一次（库里只存哈希）、**令牌不能签发令牌**之外的
 * 认证路径要稳（认不出/已吊销都返回 null，不给枚举信号）、前缀不足以还原明文。
 * 「令牌不能签发令牌」在路由层（会话检查）。
 */
const USER: AuthenticatedUser = {
  accessToken: "kfw_xxx",
  email: "u@example.com",
  id: "user-1",
  userMetadata: {},
};

function build(
  overrides: {
    create?: (input: Record<string, unknown>) => Promise<unknown>;
    findAccount?: (hash: string) => Promise<unknown>;
    revoke?: (workspaceId: string, id: string) => Promise<boolean>;
  } = {},
) {
  const created: Array<Record<string, unknown>> = [];
  const repository = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      return (
        (await overrides.create?.(input)) ?? {
          id: "tok-1",
          name: String(input.name),
          tokenPrefix: String(input.tokenPrefix),
          createdAt: "2026-09-17T00:00:00.000Z",
          lastUsedAt: null,
          revokedAt: null,
        }
      );
    }),
    list: vi.fn(async () => []),
    revoke: vi.fn(overrides.revoke ?? (async () => true)),
    findAccountByTokenHash: vi.fn(
      overrides.findAccount ??
        (async () => ({
          userId: "user-1",
          email: "u@example.com",
          userMetaData: {},
        })),
    ),
  };
  return {
    service: createApiTokenService({ repository: repository as never }),
    repository,
    created,
  };
}

describe("令牌生成与解析", () => {
  it("前缀固定、长度足够、每次不同", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(a.length).toBe(4 + 43);
    expect(a).not.toBe(b);
  });

  it("请求头解析：只认 Bearer + 本产品前缀（会话令牌不会误走这条路径）", () => {
    expect(parseApiTokenHeader("Bearer kfw_abc")).toBe("kfw_abc");
    expect(parseApiTokenHeader("bearer kfw_abc")).toBe("kfw_abc");
    expect(
      parseApiTokenHeader("Bearer session-token-without-prefix"),
    ).toBeNull();
    expect(parseApiTokenHeader(undefined)).toBeNull();
  });
});

describe("令牌服务", () => {
  it("创建：明文只回一次，库里存的是哈希与前 12 位前缀", async () => {
    const { service, created } = build();
    const result = await service.create(USER, "ws-1", "CI 部署");
    expect(result.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    const stored = created[0] as { tokenHash: string; tokenPrefix: string };
    expect(stored.tokenHash).toBe(hashApiToken(result.token));
    expect(stored.tokenPrefix).toBe(result.token.slice(0, 12));
    // 明文不在落库对象里（只写不读）
    expect(JSON.stringify(created)).not.toContain(result.token);
  });

  it("创建：空名字 400（不落库）", async () => {
    const { service, repository } = build();
    await expect(service.create(USER, "ws-1", "   ")).rejects.toMatchObject({
      code: "invalid_input",
      statusCode: 400,
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("认证路径：认得出就是那个用户；认不出/已吊销返回 null（同一口径，不给枚举信号）", async () => {
    const ok = build();
    await expect(
      ok.service.resolveUser("Bearer kfw_known"),
    ).resolves.toMatchObject({ id: "user-1", email: "u@example.com" });
    expect(ok.repository.findAccountByTokenHash).toHaveBeenCalledWith(
      hashApiToken("kfw_known"),
    );

    const miss = build({ findAccount: async () => null });
    await expect(
      miss.service.resolveUser("Bearer kfw_revoked"),
    ).resolves.toBeNull();
    expect(miss.repository.findAccountByTokenHash).toHaveBeenCalled(); // 已吊销也走查询，只是查不到

    // 非本产品前缀：**连查都不查**（换一个干净的替身，避免与上面的调用计数混在一起）
    const unrelated = build();
    await expect(
      unrelated.service.resolveUser("Bearer other"),
    ).resolves.toBeNull();
    expect(unrelated.repository.findAccountByTokenHash).not.toHaveBeenCalled();
  });

  it("吊销：不在本工作区/已吊销 → 404 可读原因", async () => {
    const { service } = build({ revoke: async () => false });
    await expect(service.revoke(USER, "ws-1", "tok-x")).rejects.toMatchObject({
      code: "not_found",
      statusCode: 404,
    });
  });
});
