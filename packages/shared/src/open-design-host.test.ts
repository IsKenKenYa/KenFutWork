import { describe, expect, it } from "vitest";
import {
  OPEN_DESIGN_EMBED_PROTOCOL_VERSION,
  openDesignHostCredentialEntrySchema,
  openDesignHostCredentialsRequestSchema,
  openDesignHostCredentialsResponseSchema,
  openDesignHostStatusResponseSchema,
} from "./open-design-host.js";

/**
 * 凭证下发缝（O3 / `OD-4`）的形状约束。
 *
 * 这条缝的响应含明文 apiKey（机器对机器、服务端到服务端的目的），所以入口的
 * 校验更要严：空 Key / 非 http(s) 基址 / 超限条数都必须在契约层就拒掉，
 * 不给「半个能用的响应」流到 daemon。
 */
describe("openDesignHost 凭证下发契约", () => {
  const entry = {
    providerId: "11111111-1111-4111-8111-111111111111",
    name: "DeepSeek",
    protocol: "openai-compatible",
    apiBase: "http://127.0.0.1:8000",
    apiKey: "sk-byok",
  };

  it("请求只带协议版本；缺省也受理", () => {
    expect(openDesignHostCredentialsRequestSchema.safeParse({}).success).toBe(
      true,
    );
    expect(
      openDesignHostCredentialsRequestSchema.safeParse({
        protocolVersion: OPEN_DESIGN_EMBED_PROTOCOL_VERSION,
      }).success,
    ).toBe(true);
    expect(
      openDesignHostCredentialsRequestSchema.safeParse({ protocolVersion: "" })
        .success,
    ).toBe(false);
  });

  it("合法响应过 schema；apiBase 可为 null（CLI 用官方默认端点）", () => {
    const parsed = openDesignHostCredentialsResponseSchema.safeParse({
      protocolVersion: OPEN_DESIGN_EMBED_PROTOCOL_VERSION,
      credentials: [{ ...entry, apiBase: null }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.credentials[0]?.apiKey).toBe("sk-byok");
  });

  it("入口红线：空 Key / 非 http(s) 基址 / 超 64 条一律拒", () => {
    expect(
      openDesignHostCredentialEntrySchema.safeParse({ ...entry, apiKey: "" })
        .success,
    ).toBe(false);
    expect(
      openDesignHostCredentialEntrySchema.safeParse({ ...entry, apiBase: 12 })
        .success,
    ).toBe(false);
    // 非 http(s)  Scheme（file:// / ftp://）不能当 API 基址
    expect(
      openDesignHostCredentialEntrySchema.safeParse({
        ...entry,
        apiBase: "file:///etc/passwd",
      }).success,
    ).toBe(false);
    expect(
      openDesignHostCredentialsResponseSchema.safeParse({
        protocolVersion: OPEN_DESIGN_EMBED_PROTOCOL_VERSION,
        credentials: Array.from({ length: 65 }, (_, index) => ({
          ...entry,
          providerId: `p-${index}`,
        })),
      }).success,
    ).toBe(false);
  });

  it("status 缝不含任何凭证字段（面板/探针永远拿不到 Key）", () => {
    const keys = Object.keys(
      openDesignHostStatusResponseSchema.parse({
        enabled: true,
        frontendUrl: "http://127.0.0.1:7456",
        reasons: [],
      }),
    );
    expect(keys.sort()).toEqual(["enabled", "frontendUrl", "reasons"]);
  });
});
