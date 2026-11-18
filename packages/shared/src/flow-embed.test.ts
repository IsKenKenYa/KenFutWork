import { describe, expect, it } from "vitest";

import {
  buildFlowHelloAck,
  buildFlowIdentity,
  isFlowProjectReady,
  parseFlowInbound,
  resolveFlowEntry,
} from "./flow-host.js";

describe("Flow project-ready binding", () => {
  it("requires the exact project and supported project-files extension", () => {
    const ready = {
      type: "ff-embed/ready" as const,
      projectId: "project-a",
      generation: 2,
      extensions: { projectFiles: "v1" },
    };
    expect(isFlowProjectReady(ready, "project-a")).toBe(true);
    expect(isFlowProjectReady(ready, "project-b")).toBe(false);
    expect(isFlowProjectReady({ ...ready, extensions: {} }, "project-a")).toBe(
      false,
    );
    for (const generation of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(isFlowProjectReady({ ...ready, generation }, "project-a")).toBe(
        false,
      );
    }
  });
});

/**
 * Flow 模式入口门控 + `ff-embed/v1` 宿主侧消息逻辑的回归锁。
 *
 * 入口纪律（AGENTS.md 不变量）：未装插件 / 适配层未配齐 → 不出现入口，
 * 且原因可读（不放无提示的空壳，也不把「探针失败」猜成「可用」）。
 */
describe("resolveFlowEntry（入口门控）", () => {
  const ready = {
    enabled: true,
    frontendUrl: "http://127.0.0.1:8080",
    reasons: [],
  };

  it("插件未装 → 不可用，原因指向插件市场", () => {
    const entry = resolveFlowEntry({
      pluginInstalled: false,
      pluginEnabled: false,
      status: ready,
    });
    expect(entry.available).toBe(false);
    expect(!entry.available && entry.reason).toContain("插件");
  });

  it("插件已装 + 适配层配齐 → 可用并透出 frontendUrl", () => {
    const entry = resolveFlowEntry({
      pluginInstalled: true,
      pluginEnabled: true,
      status: ready,
    });
    expect(entry).toEqual({
      available: true,
      frontendUrl: "http://127.0.0.1:8080",
      reason: null,
    });
  });

  it("插件已装但适配层未配齐 → 入口照常出现，原因点名缺失环境变量", () => {
    const entry = resolveFlowEntry({
      pluginInstalled: true,
      pluginEnabled: true,
      status: {
        enabled: false,
        frontendUrl: null,
        reasons: [
          "未配置 KENFUTWORK_FLOW_EMBED_SECRET（flow 网关回调宿主的共享密钥）。",
          "未配置 KENFUTWORK_FLOW_FRONTEND_URL（flow 前端地址，iframe 加载用）。",
        ],
      },
    });
    expect(entry.available).toBe(true);
    expect(entry.available && entry.frontendUrl).toBeNull();
    expect(entry.available && entry.reason).toContain(
      "KENFUTWORK_FLOW_EMBED_SECRET",
    );
    expect(entry.available && entry.reason).toContain(
      "KENFUTWORK_FLOW_FRONTEND_URL",
    );
  });

  it("插件已装但探针失败（status=null）→ 入口照常出现，原因指到 host/status", () => {
    const entry = resolveFlowEntry({
      pluginInstalled: true,
      pluginEnabled: true,
      status: null,
    });
    expect(entry.available).toBe(true);
    expect(entry.available && entry.frontendUrl).toBeNull();
    expect(entry.available && entry.reason).toContain("host/status");
  });

  it("enabled 但 frontendUrl 缺失（防御：服务端契约不该给这种组合）→ 入口出现且未就绪", () => {
    const entry = resolveFlowEntry({
      pluginInstalled: true,
      pluginEnabled: true,
      status: { enabled: true, frontendUrl: null, reasons: [] },
    });
    expect(entry.available).toBe(true);
    expect(entry.available && entry.frontendUrl).toBeNull();
  });

  it("插件停用 → 不出现入口（停用是配置态，不是运行期状态）", () => {
    const entry = resolveFlowEntry({
      pluginInstalled: true,
      pluginEnabled: false,
      status: ready,
    });
    expect(entry.available).toBe(false);
  });
});

/** 入站消息：origin 白名单 + 封闭类型集合（协议权威 flow/docs/ff-embed-v1.md）。 */
describe("parseFlowInbound（入站消息解析）", () => {
  const context = {
    origin: "http://127.0.0.1:8080",
    allowedOrigin: "http://127.0.0.1:8080",
  };

  it("白名单内的合法消息 → 原样放行", () => {
    expect(
      parseFlowInbound({ type: "ff-embed/hello", version: "v1" }, context),
    ).toMatchObject({ type: "ff-embed/hello" });
    expect(parseFlowInbound({ type: "ff-embed/ready" }, context)).toMatchObject(
      { type: "ff-embed/ready" },
    );
    expect(parseFlowInbound({ type: "ff-embed/bye" }, context)).toMatchObject({
      type: "ff-embed/bye",
    });
  });

  it("origin 不在白名单 → 静默丢弃（null），内容再合法也不收", () => {
    expect(
      parseFlowInbound(
        { type: "ff-embed/hello", version: "v1" },
        { origin: "http://evil.example", allowedOrigin: context.allowedOrigin },
      ),
    ).toBeNull();
  });

  it("非对象 / 缺 type / 未知 type / 宿主→flow 方向的 type → 丢弃", () => {
    expect(parseFlowInbound(null, context)).toBeNull();
    expect(parseFlowInbound("hello", context)).toBeNull();
    expect(parseFlowInbound({}, context)).toBeNull();
    expect(
      parseFlowInbound({ type: "kenfutwork:plugin-panel-token" }, context),
    ).toBeNull();
    // hello-ack / identity / theme 是宿主→flow 方向，flow 不会发回来
    expect(parseFlowInbound({ type: "ff-embed/identity" }, context)).toBeNull();
  });

  it("出站消息带协议版本（宿主据此被对端识别版本）", () => {
    expect(buildFlowHelloAck("v1")).toEqual({
      type: "ff-embed/hello-ack",
      version: "v1",
    });
    expect(buildFlowIdentity("v1", "tok-1")).toEqual({
      type: "ff-embed/identity",
      version: "v1",
      hostToken: "tok-1",
    });
  });
});
