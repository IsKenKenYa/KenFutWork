// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  type PluginPanelEntry,
  PluginPanelOverlay,
} from "../src/lib/plugin-panels";

/**
 * 知识库面板把预览交给宿主（2026-11-10）：面板是沙箱 iframe，正文由它用服务端
 * 接口取到（路径授权仍只在 `/api/knowledge/read` 一处），随消息带给父窗口渲染。
 *
 * 锁两件事：
 * ① 面板 iframe 发来的预览消息会让宿主弹出预览，markdown 走宿主渲染器；
 * ② 来源不是该 iframe 的消息一律忽略（不能让任意窗口把内容塞进宿主）。
 */
const panel: PluginPanelEntry = {
  id: "knowledge",
  entryId: "knowledge-sidebar",
  pluginId: "bundled__kenfutwork-knowledge",
  title: "知识库",
  slot: "sidebar",
  url: "panel.html",
  icon: null,
  configurable: false,
};

afterEach(cleanup);

function panelFrame(): HTMLIFrameElement {
  const frame = document.querySelector<HTMLIFrameElement>("iframe");
  if (!frame) throw new Error("面板 iframe 未渲染");
  return frame;
}

describe("插件面板请求宿主预览", () => {
  it("面板发来的预览消息由宿主渲染，markdown 走宿主渲染器", async () => {
    render(<PluginPanelOverlay panel={panel} onClose={() => {}} />);
    const frame = panelFrame();
    // jsdom 里 iframe 不一定有可用的 contentWindow；显式给一个，来源比对才确定。
    const source = {} as Window;
    Object.defineProperty(frame, "contentWindow", {
      value: source,
      configurable: true,
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "kenfutwork:knowledge-preview",
          name: "项目说明.md",
          content: "# 标题\n\n- 一\n- 二",
        },
        origin: window.location.origin,
        source,
      }),
    );

    await waitFor(() => expect(screen.getByText("项目说明.md")).toBeTruthy());
    // 正文进来了，且 `#` 被 markdown 消费掉（原样显示说明没走渲染器）
    expect(screen.getByText(/标题/u)).toBeTruthy();
    expect(screen.queryByText(/# 标题/u)).toBeNull();
  });

  it("来源不是面板 iframe 的消息被忽略", async () => {
    render(<PluginPanelOverlay panel={panel} onClose={() => {}} />);
    panelFrame();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "kenfutwork:knowledge-preview",
          name: "伪造.md",
          content: "# 不应出现",
        },
        origin: window.location.origin,
        source: window,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("伪造.md")).toBeNull();
  });
});
