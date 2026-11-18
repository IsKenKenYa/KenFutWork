// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserSettingsSection } from "../src/components/workbench/zcode/host/BrowserSettingsSectionAdapter";

/**
 * ZCode 设置 → 浏览器分区（宿主适配，T6）。
 *
 * 锁的是**同一数据面**：旧工作台浏览器设置并入后仍读写原来的存储与服务端端点，
 * 不造第二份真相——
 * - 服务端开关 GET/PUT `/api/permissions/tier`（browser* 字段逐一对应）；
 * - CDP 外部浏览器 `/api/browser/cdp/status|connect|disconnect`；
 * - 「AI 任务默认浏览器」读写 localStorage `workbench:browser-open-target`
 *   （与 web 端 markdown-renderer 同一份偏好）。
 */

const OPEN_TARGET_KEY = "workbench:browser-open-target";

const defaultTierView = {
  browserControlEnabled: false,
  browserAutoScreenshot: false,
  browserHeadless: false,
  browserDevtoolsReadEnabled: true,
  browserEvalEnabled: false,
};

function stubApi({
  tierView = defaultTierView,
  cdp = { status: "disconnected" },
  putError,
}: {
  tierView?: typeof defaultTierView;
  cdp?: unknown;
  putError?: string;
} = {}) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" && init.body !== "{}"
          ? JSON.parse(init.body)
          : undefined;
      calls.push({ path, method, body });
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (path === "/api/permissions/tier") {
        if (method === "PUT") {
          if (putError) return json({ error: { message: putError } }, 400);
          return json({ ...tierView, ...(body as object) });
        }
        return json(tierView);
      }
      if (path === "/api/browser/cdp/status") return json({ cdp });
      if (path === "/api/browser/cdp/connect") {
        return json({
          cdp: {
            status: "connected",
            browser: "Chrome/120",
            tabs: 3,
            currentUrl: "about:blank",
            headless: false,
          },
        });
      }
      if (path === "/api/browser/cdp/disconnect")
        return json({ cdp: { status: "disconnected" } });
      return json({ error: { message: "not found" } }, 404);
    }),
  );
  return calls;
}

function renderSection() {
  render(<BrowserSettingsSection isDesktop={false} />);
  return userEvent.setup();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

// jsdom 没有 Pointer Capture / scrollIntoView / ResizeObserver，Select 弹层交互需要（radix 底层）
beforeAll(() => {
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.releasePointerCapture = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // 不用 vi.stubGlobal：afterEach 的 unstubAllGlobals 会把它拆掉，后面的用例就打不开弹层
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// Select 弹层用例放最前：userEvent 在同文件更早的用例里留下的 pointer 状态
// 会让 radix 弹层在后续用例打不开（实测），这里控制在任何 userEvent 交互之前执行。
describe("浏览器分区（宿主适配）：AI 任务默认浏览器（localStorage 同一数据面）", () => {
  it("读旧键 workbench:browser-open-target 呈现当前值", async () => {
    window.localStorage.setItem(OPEN_TARGET_KEY, "system");
    stubApi();
    renderSection();

    const trigger = await screen.findByLabelText("AI 任务默认浏览器");
    expect(trigger.textContent).toContain("外部浏览器");
  });

  it("改选写回同一个键（与 web 端 markdown-renderer 共享）", async () => {
    stubApi();
    renderSection();

    const trigger = await screen.findByLabelText("AI 任务默认浏览器");
    expect(trigger.textContent).toContain("内置浏览器");
    // radix Select 弹层在 jsdom 里要用带 isPrimary 的 pointerDown 打开（userEvent 不带）
    fireEvent.pointerDown(trigger, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      ctrlKey: false,
      isPrimary: true,
    });
    fireEvent.click(await screen.findByRole("option", { name: "外部浏览器" }));

    expect(window.localStorage.getItem(OPEN_TARGET_KEY)).toBe("system");
  });
});

describe("浏览器分区（宿主适配）：服务端开关", () => {
  it("五个开关按服务端真值呈现；点开关写 PUT /api/permissions/tier", async () => {
    const calls = stubApi();
    const user = renderSection();

    const devtools = await screen.findByRole("switch", {
      name: "允许 AI 读取开发者工具数据",
    });
    expect(devtools).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("switch", { name: "允许 AI 控制浏览器" }),
    ).toHaveAttribute("aria-checked", "false");

    await user.click(devtools);
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/api/permissions/tier",
        method: "PUT",
        body: { browserDevtoolsReadEnabled: false },
      }),
    );
    expect(
      screen.getByRole("switch", { name: "允许 AI 读取开发者工具数据" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("写入失败回滚开关，服务端原因原样透出", async () => {
    stubApi({ putError: "写入失败" });
    const user = renderSection();

    const toggle = await screen.findByRole("switch", { name: "自动截图" });
    await user.click(toggle);

    expect(
      await screen.findByRole("switch", { name: "自动截图" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(await screen.findByText("写入失败")).toBeVisible();
  });
});

describe("浏览器分区（宿主适配）：外部浏览器（CDP）", () => {
  it("已连接时显示状态与「断开」，点击真发 disconnect", async () => {
    const calls = stubApi({
      cdp: {
        status: "connected",
        browser: "Chrome/120",
        tabs: 3,
        currentUrl: "",
        headless: false,
      },
    });
    const user = renderSection();

    expect(await screen.findByText(/Chrome\/120 · 3 个标签/)).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "断开" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/api/browser/cdp/disconnect",
        method: "POST",
      }),
    );
  });

  it("未连接时给「连接到 Chrome」，成功后状态行更新", async () => {
    const calls = stubApi();
    const user = renderSection();

    await user.click(
      await screen.findByRole("button", { name: "连接到 Chrome" }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/api/browser/cdp/connect",
        method: "POST",
      }),
    );
    expect(await screen.findByRole("button", { name: "断开" })).toBeVisible();
  });
});
