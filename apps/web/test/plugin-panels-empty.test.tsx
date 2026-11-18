// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PLUGIN_INVENTORY_CHANGED_EVENT,
  PluginPanelButtons,
} from "../src/lib/plugin-panels";

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
  it.each(["canvas", "conversation"])(
    "Design的%s槽只显示Design及共享插件",
    async (slot) => {
      stubPlugins(
        ["code", "design", "shared"].map((scope) => ({
          id: `local__${scope}`,
          installed: true,
          enabled: true,
          scope,
          ui: [
            {
              id: "entry",
              title: `${scope}入口`,
              slot,
              url: "panel",
              icon: null,
            },
          ],
        })),
      );
      render(
        <PluginPanelButtons
          accessToken={null}
          slot={slot}
          mode="design"
          renderButton={(panel) => (
            <button type="button" key={panel.id}>
              {panel.title}
            </button>
          )}
        />,
      );
      await screen.findByRole("button", { name: "design入口" });
      expect(screen.getByRole("button", { name: "shared入口" })).not.toBeNull();
      expect(screen.queryByRole("button", { name: "code入口" })).toBeNull();
    },
  );

  it("读取失败显示真实错误，不伪装没有面板", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: { message: "插件服务不可用" } }, { status: 503 }),
    );
    render(
      <PluginPanelButtons
        accessToken={null}
        slot="settings"
        emptyLabel="没有面板"
        renderButton={() => null}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "插件服务不可用",
    );
    expect(screen.queryByText("没有面板")).toBeNull();
  });

  it("目录刷新收回停用面板，旧读取晚到不能恢复已删除入口", async () => {
    const plugin = {
      id: "local__devices",
      installed: true,
      enabled: true,
      scope: "shared",
      ui: [
        {
          id: "panel",
          title: "米家",
          slot: "sidebar",
          url: "panel",
          icon: null,
        },
      ],
    };
    let reads = 0;
    let finishOld: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", async () => {
      reads++;
      if (reads === 2)
        return new Promise<Response>((resolve) => {
          finishOld = resolve;
        });
      return Response.json({ plugins: reads === 1 ? [plugin] : [] });
    });
    render(
      <PluginPanelButtons
        accessToken={null}
        slot="sidebar"
        mode="design"
        renderButton={(panel, open) => (
          <button key={panel.id} type="button" onClick={open}>
            {panel.title}
          </button>
        )}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "米家" }));
    await screen.findByTitle("米家");
    fireEvent(window, new Event(PLUGIN_INVENTORY_CHANGED_EVENT));
    fireEvent(window, new Event(PLUGIN_INVENTORY_CHANGED_EVENT));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "米家" })).toBeNull(),
    );
    await waitFor(() => expect(screen.queryByTitle("米家")).toBeNull());
    if (!finishOld) throw new Error("未建立延迟目录请求");
    await act(async () => {
      finishOld?.(Response.json({ plugins: [plugin] }));
    });
    await waitFor(() => expect(reads).toBe(3));
    expect(screen.queryByRole("button", { name: "米家" })).toBeNull();
  });

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
        enabled: true,
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
        enabled: false,
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
        enabled: true,
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
