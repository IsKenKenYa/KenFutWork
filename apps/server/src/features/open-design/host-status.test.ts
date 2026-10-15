import { describe, expect, it, vi } from "vitest";

import {
  OPEN_DESIGN_PROBE_TIMEOUT_MS,
  resolveOpenDesignHostStatus,
} from "./host-status.js";

const ORIGIN = "http://127.0.0.1:7456";
const asFetch = (impl: unknown) => impl as unknown as typeof fetch;

describe("OpenDesign 宿主状态探针", () => {
  it("未配置前端地址 → disabled、地址为 null、原因点名缺什么，且不发请求", async () => {
    const fetchImpl = vi.fn();
    const status = await resolveOpenDesignHostStatus({
      frontendUrl: undefined,
      fetchImpl: asFetch(fetchImpl),
    });
    expect(status).toEqual({
      enabled: false,
      frontendUrl: null,
      reasons: ["未配置 OpenDesign 前端地址。"],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("空白地址按未配置处理（trim 后为空不算配好）", async () => {
    const fetchImpl = vi.fn();
    const status = await resolveOpenDesignHostStatus({
      frontendUrl: "   ",
      fetchImpl: asFetch(fetchImpl),
    });
    expect(status.enabled).toBe(false);
    expect(status.frontendUrl).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("服务可达（2xx）→ enabled，地址原样透出，且探针带超时信号", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("ok", { status: 200 }),
    );
    const status = await resolveOpenDesignHostStatus({
      frontendUrl: ORIGIN,
      fetchImpl: asFetch(fetchImpl),
    });
    expect(status).toEqual({
      enabled: true,
      frontendUrl: ORIGIN,
      reasons: [],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // 探活打上游免鉴权健康端点（真机实证：配 token 时 GET / 回 Basic Auth 401）
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${ORIGIN}/api/health`);
    // 探针必须带超时：承载是独立服务，探不通不能把 status 拖成挂起。
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("服务回非 2xx → disabled，原因带状态码（地址仍回填，面板能显示落点）", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    const status = await resolveOpenDesignHostStatus({
      frontendUrl: ORIGIN,
      fetchImpl: asFetch(fetchImpl),
    });
    expect(status.enabled).toBe(false);
    expect(status.frontendUrl).toBe(ORIGIN);
    expect(status.reasons.join(" ")).toContain("503");
  });

  it("连接被拒 → disabled，原因带底层信息而不是空话", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:7456");
    });
    const status = await resolveOpenDesignHostStatus({
      frontendUrl: ORIGIN,
      fetchImpl: asFetch(fetchImpl),
    });
    expect(status.enabled).toBe(false);
    expect(status.reasons.join(" ")).toContain("ECONNREFUSED");
  });

  it("超时 → disabled，原因说「超时」而不是裸错误名", async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    });
    const status = await resolveOpenDesignHostStatus({
      frontendUrl: ORIGIN,
      fetchImpl: asFetch(fetchImpl),
    });
    expect(status.enabled).toBe(false);
    expect(status.reasons.join(" ")).toContain("超时");
    expect(status.reasons.join(" ")).not.toContain("TimeoutError");
  });

  it("超长错误信息被压到 200 字以内（不把底层栈灌进界面）", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("x".repeat(1000));
    });
    const status = await resolveOpenDesignHostStatus({
      frontendUrl: ORIGIN,
      fetchImpl: asFetch(fetchImpl),
    });
    expect(status.reasons[0]?.length).toBeLessThanOrEqual(240);
  });

  it("默认探活超时有上界（status 是门控同步依赖，不能挂起）", () => {
    expect(OPEN_DESIGN_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(OPEN_DESIGN_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });

  // ---- 伴随容器承载事实（§9-3 拍板：伴随容器随主程序起停）----

  it("托管模式 + 容器启动中 → 探活失败原因追加「正在启动」的等待说明", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:7456");
    });
    const status = await resolveOpenDesignHostStatus({
      frontendUrl: ORIGIN,
      fetchImpl: asFetch(fetchImpl),
      companion: { state: "starting" },
    });
    expect(status.enabled).toBe(false);
    expect(status.reasons.join(" ")).toContain("正在启动");
    expect(status.reasons.join(" ")).toContain("拉取镜像");
  });

  it("托管模式 + 容器启动失败 → 原因透传失败摘要（不是只说「不可达」）", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 502 }));
    const status = await resolveOpenDesignHostStatus({
      frontendUrl: ORIGIN,
      fetchImpl: asFetch(fetchImpl),
      companion: {
        state: "error",
        error: "docker compose up 失败（退出码 125）：pull access denied",
      },
    });
    expect(status.reasons.join(" ")).toContain("pull access denied");
  });

  it("外部地址（非伴随 origin）→ 伴随快照不掺和，原因只有 HTTP 事实", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.9:7456");
    });
    const status = await resolveOpenDesignHostStatus({
      frontendUrl: "http://10.0.0.9:7456",
      fetchImpl: asFetch(fetchImpl),
      companion: { state: "error", error: "不该出现" },
    });
    expect(status.reasons.join(" ")).not.toContain("伴随容器");
    expect(status.reasons.join(" ")).not.toContain("不该出现");
  });

  it("托管模式 + 容器 ready 但 HTTP 不通 → 不追加容器侧原因（基线已说明）", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:7456");
    });
    const status = await resolveOpenDesignHostStatus({
      frontendUrl: ORIGIN,
      fetchImpl: asFetch(fetchImpl),
      companion: { state: "ready" },
    });
    expect(status.reasons).toHaveLength(1);
  });

  it("服务可达时不受伴随快照影响（enabled 语义 = 真的能用）", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const status = await resolveOpenDesignHostStatus({
      frontendUrl: ORIGIN,
      fetchImpl: asFetch(fetchImpl),
      companion: { state: "error", error: "陈旧失败" },
    });
    expect(status).toEqual({ enabled: true, frontendUrl: ORIGIN, reasons: [] });
  });
});
