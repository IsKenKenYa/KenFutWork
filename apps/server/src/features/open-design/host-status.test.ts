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
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(ORIGIN);
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
});
