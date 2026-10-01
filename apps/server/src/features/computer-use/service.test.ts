import { describe, expect, it } from "vitest";

import type { AxNode } from "./ax-tree.js";
import {
  createComputerUseService,
  type CuGovernanceValues,
} from "./service.js";
import type {
  ComputerUseExecutor,
  CuAppInfo,
  CuObservation,
  CuRaster,
} from "./executor.js";

const governance: CuGovernanceValues = {
  actionTimeoutMs: 10_000,
  observeMaxBytes: 32_768,
  screenshotMaxBytes: 262_144,
  maxActionsPerRun: 3,
  sessionMaxMs: 1_800_000,
};

const tree: AxNode = {
  role: "group",
  title: "Keypad",
  children: [
    { role: "button", title: "7", states: ["pressable"], actions: ["AXPress"] },
    { role: "button", title: "8", states: ["pressable"], actions: ["AXPress"] },
  ],
};

function fakeRaster(overrides: Partial<CuRaster> = {}): CuRaster {
  return {
    frameId: "frame-1",
    mimeType: "image/png",
    width: 230,
    height: 408,
    base64: "aW1hZ2U=",
    blackFrame: false,
    ...overrides,
  };
}

function fakeExecutor(overrides: Partial<ComputerUseExecutor> = {}) {
  const calls: string[] = [];
  let frameSeq = 0;
  const executor: ComputerUseExecutor = {
    id: "fake",
    available: true,
    async listApps(): Promise<CuAppInfo[]> {
      calls.push("listApps");
      return [
        { pid: 1, name: "计算器", bundleId: "com.apple.calculator", active: true },
      ];
    },
    async listWindows() {
      return [
        {
          windowId: 6363,
          title: "计算器",
          subrole: "AXStandardWindow",
          bounds: [990, 382, 230, 408],
          main: true,
          focused: true,
        },
      ];
    },
    async observe(): Promise<CuObservation> {
      calls.push("observe");
      return {
        app: { pid: 1, bundleId: "com.apple.calculator", name: "计算器" },
        window: { windowId: 6363, title: "计算器", bounds: [990, 382, 230, 408] },
        root: tree,
      };
    },
    async capture() {
      calls.push("capture");
      return fakeRaster({ frameId: `frame-${++frameSeq}` });
    },
    async click(_appRef, target) {
      calls.push(`click:${JSON.stringify(target)}`);
      return { actionSent: true, detail: "已点击" };
    },
    async typeText(_appRef, text) {
      calls.push(`type:${text}`);
      return { actionSent: true, detail: "已输入" };
    },
    async accessStatus() {
      return {
        accessibility: "granted",
        screen: "granted",
        hint: "权限已就绪",
      };
    },
    async stop() {
      calls.push("stop");
    },
    ...overrides,
  };
  return { executor, calls };
}

const APP = { bundleId: "com.apple.calculator" };

describe("ComputerUseService：执行器不可用必须 fail loud", () => {
  it("所有工具面显式报 unavailable（isError + 原因），不冒充成功", async () => {
    const service = createComputerUseService({
      executor: {
        ...fakeExecutor().executor,
        id: "unavailable",
        available: false,
        unavailableReason: "平台不支持",
      },
      governance: () => governance,
    });
    for (const result of [
      await service.listApps(),
      await service.requestAccess(),
      await service.getState(APP, {}),
      await service.screenshot(APP),
    ]) {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("平台不支持");
    }
  });
});

describe("ComputerUseService：观察", () => {
  it("getAppState 返回树文本 + structuredContent", async () => {
    const { executor } = fakeExecutor();
    const service = createComputerUseService({
      executor,
      governance: () => governance,
    });
    const result = await service.getState(APP, {});
    expect(result.isError).toBeUndefined();
    const first = result.content[0];
    expect(first?.type).toBe("text");
    expect(first?.type === "text" ? first.text : "").toContain(
      "[1] button 7 (pressable)",
    );
    expect(result.structuredContent?.state_id).toMatch(/^s-\d+$/);
    expect(result.structuredContent?.element_count).toBe(3);
  });

  it("getAppState 观察预算生效（治理 observeMaxBytes）", async () => {
    const { executor } = fakeExecutor();
    const service = createComputerUseService({
      executor,
      governance: () => ({ ...governance, observeMaxBytes: 4_096 }),
    });
    const big: AxNode = {
      role: "group",
      title: "L0",
      children: Array.from({ length: 200 }, (_, i) => ({
        role: "button",
        title: `btn-${i}-${"y".repeat(40)}`,
      })),
    };
    const swapped = fakeExecutor({
      observe: async () => ({
        app: { pid: 1, bundleId: "x", name: "x" },
        window: { windowId: 1, title: "x" },
        root: big,
      }),
    });
    const service2 = createComputerUseService({
      executor: swapped.executor,
      governance: () => ({ ...governance, observeMaxBytes: 4_096 }),
    });
    const result = await service2.getState(APP, {});
    expect(result.structuredContent?.trimmed).toBeGreaterThan(0);
  });

  it("黑帧截图 → permission_denied + 引导（不信权限查询）", async () => {
    const { executor } = fakeExecutor({
      capture: async () => fakeRaster({ blackFrame: true }),
      accessStatus: async () => ({
        accessibility: "granted",
        screen: "granted",
        hint: "",
      }),
    });
    const service = createComputerUseService({
      executor,
      governance: () => governance,
    });
    const result = await service.screenshot(APP);
    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent?.error as { code?: string })?.code,
    ).toBe("permission_denied");
    expect(JSON.stringify(result)).toContain("屏幕录制");
  });

  it("正常截图 → image 内容块 + structuredContent.image", async () => {
    const { executor } = fakeExecutor();
    const service = createComputerUseService({
      executor,
      governance: () => governance,
    });
    const result = await service.screenshot(APP);
    expect(result.isError).toBeUndefined();
    expect(
      result.content.some((c) => c.type === "image" && c.data === "aW1hZ2U="),
    ).toBe(true);
    expect(result.structuredContent?.image).toMatchObject({
      mimeType: "image/png",
      width: 230,
      height: 408,
    });
  });

  it("requestAccess 返回 permissionStatus 形状", async () => {
    const { executor } = fakeExecutor();
    const service = createComputerUseService({
      executor,
      governance: () => governance,
    });
    const result = await service.requestAccess();
    expect(result.structuredContent?.permissionStatus).toEqual({
      accessibility: "granted",
      screen: "granted",
    });
  });
});

describe("ComputerUseService：动作", () => {
  it("元素索引点击：先观察建立树，索引有效则下发并回 actionSent", async () => {
    const { executor, calls } = fakeExecutor();
    const service = createComputerUseService({
      executor,
      governance: () => governance,
    });
    await service.getState(APP, {});
    const result = await service.click(APP, { type: "element", index: 1 }, "run-A");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.actionSent).toBe(true);
    expect(calls).toContain('click:{"kind":"element","index":1}');
  });

  it("索引不在最新树 → element_unavailable（fail closed）", async () => {
    const { executor } = fakeExecutor();
    const service = createComputerUseService({
      executor,
      governance: () => governance,
    });
    await service.getState(APP, {});
    const result = await service.click(APP, { type: "element", index: 99 }, "run-A");
    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent?.error as { code?: string })?.code,
    ).toBe("element_unavailable");
  });

  it("坐标过期帧 → element_stale（retry=reobserve）", async () => {
    const { executor } = fakeExecutor();
    const service = createComputerUseService({
      executor,
      governance: () => governance,
    });
    await service.getState(APP, { includeScreenshot: true });
    // 新一帧到达后旧坐标过期：再截一张推进 frameId
    await service.screenshot(APP);
    const result = await service.click(
      APP,
      { type: "coordinate", x: 10, y: 10, frameId: "frame-1" },
      "run-A",
    );
    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent?.error as { code?: string })?.code,
    ).toBe("element_stale");
  });

  it("租约互斥：run-B 在 run-A 持有期间 → controller_busy", async () => {
    const { executor } = fakeExecutor();
    const service = createComputerUseService({
      executor,
      governance: () => governance,
    });
    await service.getState(APP, {});
    await service.click(APP, { type: "element", index: 1 }, "run-A");
    const result = await service.click(APP, { type: "element", index: 1 }, "run-B");
    expect(result.isError).toBe(true);
    const error = result.structuredContent?.error as { code?: string; owner?: string };
    expect(error?.code).toBe("controller_busy");
    expect(error?.owner).toBe("run-A");
  });

  it("stop 释放租约：下一个 run 可接管", async () => {
    const { executor, calls } = fakeExecutor();
    const service = createComputerUseService({
      executor,
      governance: () => governance,
    });
    await service.getState(APP, {});
    await service.click(APP, { type: "element", index: 1 }, "run-A");
    await service.stop("run-A");
    expect(calls).toContain("stop");
    const result = await service.click(APP, { type: "element", index: 1 }, "run-B");
    expect(result.isError).toBeUndefined();
  });

  it("单 run 动作上限（治理 maxActionsPerRun）", async () => {
    const { executor } = fakeExecutor();
    const service = createComputerUseService({
      executor,
      governance: () => governance,
    });
    await service.getState(APP, {});
    await service.click(APP, { type: "element", index: 1 }, "run-A");
    await service.click(APP, { type: "element", index: 1 }, "run-A");
    await service.click(APP, { type: "element", index: 1 }, "run-A");
    const result = await service.click(APP, { type: "element", index: 1 }, "run-A");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("达到上限");
  });

  it("type 走同一套校验与租约", async () => {
    const { executor, calls } = fakeExecutor();
    const service = createComputerUseService({
      executor,
      governance: () => governance,
    });
    await service.getState(APP, {});
    const result = await service.typeText(APP, "hello", undefined, "run-A");
    expect(result.isError).toBeUndefined();
    expect(calls).toContain("type:hello");
  });
});
