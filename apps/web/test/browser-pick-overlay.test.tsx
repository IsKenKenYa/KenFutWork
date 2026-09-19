// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserPane,
  formatElementReference,
} from "../src/components/workbench/panel-browser-view";
import { withAppProviders } from "./test-providers";

/**
 * 元素拾取浮层（R3-4）：受控浏览器（CDP）连着时，服务端回来的元素带**真实几何**
 * （`DOM.getBoxModel` 的边框盒）+ 一张视口截图，浮层在截图上叠框点选。
 *
 * 锁三件事：① 框按「盒 ÷ 视口」换算成百分比（截图与几何同一套坐标）；
 * ② 点框与点列表行是同一个动作（都交给对话）；③ 没有几何（静态抓取那条路）时
 * 不出叠框，列表照旧可用。
 */

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const CDP_RESPONSE = {
  source: "cdp",
  screenshotUrl: "https://blob.test/browser/shot.png",
  snapshot: {
    url: "https://example.com/",
    title: "Example",
    text: "正文",
    viewport: { width: 1000, height: 500 },
    elements: [
      {
        tag: "button",
        text: "立即开始",
        hint: "button#start",
        box: { x: 200, y: 100, width: 100, height: 50 },
      },
      {
        tag: "a",
        text: "Learn more",
        hint: "a#more",
        box: { x: 0, y: 0, width: 50, height: 25 },
      },
    ],
  },
};

function renderPane(
  props: Partial<React.ComponentProps<typeof BrowserPane>> = {},
) {
  const onPickElement = vi.fn();
  render(
    withAppProviders(
      <BrowserPane
        url="https://example.com/"
        draft="https://example.com/"
        reloadToken={0}
        canBack={false}
        canForward={false}
        accessToken="tok"
        onPickElement={onPickElement}
        onDraftChange={() => {}}
        onNavigate={() => {}}
        onBack={() => {}}
        onForward={() => {}}
        onReload={() => {}}
        {...props}
      />,
    ),
  );
  return { onPickElement };
}

async function openPicking() {
  await userEvent.click(
    screen.getByRole("button", { name: "选择网页元素加入聊天" }),
  );
  await screen.findByRole("dialog", { name: "选择网页元素加入聊天" });
}

describe("元素拾取浮层", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
  });
  afterEach(cleanup);

  it("CDP 路径：截图 + 按视口换算的叠框 + 带坐标的列表", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CDP_RESPONSE,
    });
    renderPane();
    await openPicking();

    // 截图当底图
    expect(await screen.findByAltText("Example 的视口截图")).toHaveAttribute(
      "src",
      "https://blob.test/browser/shot.png",
    );

    // 叠框：200/1000 = 20%、100/500 = 20%、100/1000 = 10%、50/500 = 10%
    const hotspot = screen.getByRole("button", {
      name: "拾取元素 1：button 立即开始",
    });
    expect(hotspot).toHaveStyle({
      left: "20%",
      top: "20%",
      width: "10%",
      height: "10%",
    });
    // 静态那条路的说明不该出现在 CDP 路径里
    expect(screen.queryByText(/来源：页面快照/)).not.toBeInTheDocument();
  });

  it("点截图上的框 = 点列表行：交给对话的元素带 box（浮层收起）", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CDP_RESPONSE,
    });
    const { onPickElement } = renderPane();
    await openPicking();

    await userEvent.click(
      screen.getByRole("button", { name: "拾取元素 1：button 立即开始" }),
    );

    expect(onPickElement).toHaveBeenCalledWith({
      pageUrl: "https://example.com/",
      pageTitle: "Example",
      tag: "button",
      text: "立即开始",
      hint: "button#start",
      box: { x: 200, y: 100, width: 100, height: 50 },
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "选择网页元素加入聊天" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("静态抓取（元素没有几何）：不出叠框，列表照旧可点", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        source: "static",
        snapshot: {
          url: "https://example.com/",
          title: "Example",
          elements: [{ tag: "a", text: "Learn more", hint: "a" }],
        },
      }),
    });
    const { onPickElement } = renderPane();
    await openPicking();

    expect(screen.queryByAltText("Example 的视口截图")).not.toBeInTheDocument();
    expect(screen.getByText(/来源：页面快照/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /Learn more/ }));
    expect(onPickElement).toHaveBeenCalledWith({
      pageUrl: "https://example.com/",
      pageTitle: "Example",
      tag: "a",
      text: "Learn more",
      hint: "a",
    });
  });

  it("引用行带中心坐标（CDP 路径才有）：agent 可直接照着点", () => {
    const withBox = formatElementReference({
      pageUrl: "https://example.com/",
      pageTitle: "Example",
      tag: "button",
      text: "立即开始",
      hint: "button#start",
      box: { x: 200, y: 100, width: 100, height: 50 },
    });
    expect(withBox).toContain("中心坐标：250,125");
    expect(withBox).toContain("browser_act");

    // 没有几何时不加这一段（静态那条路）
    const withoutBox = formatElementReference({
      pageUrl: "https://example.com/",
      pageTitle: "Example",
      tag: "a",
      text: "Learn more",
      hint: "a",
    });
    expect(withoutBox).not.toContain("中心坐标");
    expect(withoutBox).toBe(
      "【页面元素】<a> Learn more ｜ 定位提示：a ｜ 来自：Example（https://example.com/）",
    );
  });
});
