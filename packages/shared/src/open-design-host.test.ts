import { describe, expect, it } from "vitest";
import {
  buildOpenDesignHelloAck,
  buildOpenDesignNavigate,
  isAllowedOpenDesignOrigin,
  OPEN_DESIGN_EMBED_PROTOCOL_VERSION,
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
