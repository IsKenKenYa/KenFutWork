import { describe, expect, it } from "vitest";
import {
  buildOpenDesignHelloAck,
  buildOpenDesignNavigate,
  isAllowedOpenDesignOrigin,
  OPEN_DESIGN_EMBED_PROTOCOL_VERSION,
  openDesignHostCredentialEntrySchema,
  openDesignHostCredentialsRequestSchema,
  openDesignHostCredentialsResponseSchema,
  openDesignHostStatusResponseSchema,
  openDesignInboundMessageSchema,
  parseOpenDesignInbound,
} from "./open-design-host.js";

/**
 * `od/v1` 嵌入协议的安全双闸（《OpenDesign 集成规划》§8 风险 5）。
 *
 * 两道闸是**独立**的：origin 白名单挡跨源伪造，schema 校验挡同源但形状不对的消息。
 * 缺任何一道都等于把面板当成可信输入源。
 */
describe("od/v1 入站消息校验", () => {
  it("合法消息过 schema，类型不明 / 字段越界一律丢弃", () => {
    expect(
      parseOpenDesignInbound({
        type: "od/hello",
        version: OPEN_DESIGN_EMBED_PROTOCOL_VERSION,
      }),
    ).toEqual({
      type: "od/hello",
      version: OPEN_DESIGN_EMBED_PROTOCOL_VERSION,
    });
    expect(
      parseOpenDesignInbound({
        type: "od/navigate-complete",
        version: OPEN_DESIGN_EMBED_PROTOCOL_VERSION,
        path: "canvas/main",
      }),
    ).toEqual({
      type: "od/navigate-complete",
      version: OPEN_DESIGN_EMBED_PROTOCOL_VERSION,
      path: "canvas/main",
    });

    // 类型不在白名单内（宽进宽出会被这里挡掉）
    expect(
      parseOpenDesignInbound({ type: "od/evil", version: "v1" }),
    ).toBeNull();
    expect(parseOpenDesignInbound({ type: "message" })).toBeNull();
    expect(parseOpenDesignInbound("od/hello")).toBeNull();
    expect(parseOpenDesignInbound(null)).toBeNull();
    // 字段越界 / 缺字段
    expect(
      parseOpenDesignInbound({ type: "od/navigate-complete", version: "v1" }),
    ).toBeNull();
    expect(
      parseOpenDesignInbound({
        type: "od/navigate-complete",
        version: "v1",
        path: "x".repeat(2049),
      }),
    ).toBeNull();
  });

  it("origin 白名单：只认配置里的那个前端 origin", () => {
    expect(
      isAllowedOpenDesignOrigin(
        "http://127.0.0.1:7456",
        "http://127.0.0.1:7456",
      ),
    ).toBe(true);
    // 换端口 / 换协议 / 换主机都不算同一个来源
    expect(
      isAllowedOpenDesignOrigin(
        "http://127.0.0.1:7457",
        "http://127.0.0.1:7456",
      ),
    ).toBe(false);
    expect(
      isAllowedOpenDesignOrigin(
        "https://127.0.0.1:7456",
        "http://127.0.0.1:7456",
      ),
    ).toBe(false);
    expect(
      isAllowedOpenDesignOrigin("http://evil.example", "http://127.0.0.1:7456"),
    ).toBe(false);
    // 空 origin（sandbox 内的 iframe 等）一律不认
    expect(isAllowedOpenDesignOrigin("", "http://127.0.0.1:7456")).toBe(false);
  });

  it("出站消息只由宿主构造，版本号恒定", () => {
    expect(buildOpenDesignHelloAck()).toEqual({
      type: "od/hello-ack",
      version: OPEN_DESIGN_EMBED_PROTOCOL_VERSION,
    });
    expect(buildOpenDesignNavigate("canvas/main")).toEqual({
      type: "od/navigate",
      version: OPEN_DESIGN_EMBED_PROTOCOL_VERSION,
      path: "canvas/main",
    });
  });

  it("出入站 schema 互不串用（同源但方向错了也不收）", () => {
    // 宿主只会收到入站 schema 里的类型；把出站类型塞进入站校验必须被拒。
    expect(
      openDesignInboundMessageSchema.safeParse(buildOpenDesignHelloAck())
        .success,
    ).toBe(false);
    expect(
      openDesignInboundMessageSchema.safeParse(buildOpenDesignNavigate("a"))
        .success,
    ).toBe(false);
  });
});

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
