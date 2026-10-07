// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginPanelButtons } from "../src/lib/plugin-panels";

/**
 * 设置 → 插件面板 的空态（回归）。
 *
 * 缺陷：那一页当时**什么都没渲染**——`PluginPanelButtons` 在面板列表为空时输出空数组，
 * 于是整页只剩关闭按钮，用户看到的是一块白板（真机截图确认）。页面的文档注释明明写着
 * 「没有插件声明该槽位时，明确说明『当前没有插件提供设置面板』」，代码没兑现。
 *
 * 这里锁两件事：
 * ① 传了 `emptyLabel` 的列表页，空列表必须把这句话说出来；
 * ② 不传的**入口点**（侧栏 / 画布 / 对话槽位）空列表仍然什么都不渲染——
 *    入口空着就该整个不出现（AGENTS.md「不摆空壳、不放假开关」），不能顺手加个空态出来。
 */
function stubPlugins(plugins: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ plugins }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("插件面板空态", () => {
  it("列表页（传 emptyLabel）：没有面板时明说，不留白板", async () => {
    stubPlugins([]);
    render(
      <PluginPanelButtons
        accessToken="t"
        slot="settings"
        emptyLabel="当前没有插件提供设置面板"
        renderButton={() => null}
      />,
    );
    expect(
      await screen.findByText("当前没有插件提供设置面板"),
    ).toBeInTheDocument();
  });

  it("入口点（不传 emptyLabel）：没有面板时什么都不渲染", async () => {
    stubPlugins([]);
    const { container } = render(
      <PluginPanelButtons
        accessToken="t"
        slot="sidebar"
        renderButton={() => null}
      />,
    );
    // 等到取数落地（fetch 桩是立刻 resolve 的），仍然必须是空的
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("有面板时：渲染按钮，且不出现空态文案", async () => {
    stubPlugins([
      {
        id: "local__demo",
        installed: true,
        ui: [{ id: "panel", title: "演示面板", slot: "settings", url: "p" }],
      },
    ]);
    render(
      <PluginPanelButtons
        accessToken="t"
        slot="settings"
        emptyLabel="当前没有插件提供设置面板"
        renderButton={(panel) => (
          <button key={panel.id} type="button">
            {panel.title}
          </button>
        )}
      />,
    );
    expect(await screen.findByText("演示面板")).toBeInTheDocument();
    expect(screen.queryByText("当前没有插件提供设置面板")).toBeNull();
  });

  it("未安装的插件不算数：面板不出现，空态照说", async () => {
    stubPlugins([
      {
        id: "owner__repo",
        installed: false,
        ui: [{ id: "panel", title: "未装面板", slot: "settings", url: "p" }],
      },
    ]);
    render(
      <PluginPanelButtons
        accessToken="t"
        slot="settings"
        emptyLabel="当前没有插件提供设置面板"
        renderButton={(panel) => (
          <button key={panel.id} type="button">
            {panel.title}
          </button>
        )}
      />,
    );
    expect(
      await screen.findByText("当前没有插件提供设置面板"),
    ).toBeInTheDocument();
    expect(screen.queryByText("未装面板")).toBeNull();
  });

  it("槽位不匹配的面板不算数（settings 页不看 sidebar 槽位）", async () => {
    stubPlugins([
      {
        id: "local__demo",
        installed: true,
        ui: [{ id: "panel", title: "侧栏面板", slot: "sidebar", url: "p" }],
      },
    ]);
    render(
      <PluginPanelButtons
        accessToken="t"
        slot="settings"
        emptyLabel="当前没有插件提供设置面板"
        renderButton={(panel) => (
          <button key={panel.id} type="button">
            {panel.title}
          </button>
        )}
      />,
    );
    expect(
      await screen.findByText("当前没有插件提供设置面板"),
    ).toBeInTheDocument();
    expect(screen.queryByText("侧栏面板")).toBeNull();
  });
});
