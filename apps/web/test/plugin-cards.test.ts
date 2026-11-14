import type { PluginCardDeclaration } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import {
  pluginCardRenderer,
  pluginCardView,
} from "../src/components/workbench/zcode/host/pluginCardRenderer.js";
import {
  collectPluginCards,
  findPluginCard,
  loadPluginCards,
} from "../src/components/workbench/zcode/host/pluginCards.js";

const CARD: PluginCardDeclaration = {
  tools: ["demo_echo"],
  title: "插件执行结果",
  fields: [
    { label: "输入", value: "<b>hello</b>" },
    { label: "耗时毫秒", value: 12 },
  ],
  status: "success",
};

function marketEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "card-plugin",
    name: "card-plugin",
    title: "卡片插件",
    description: "演示声明式卡片",
    source: "url" as const,
    repositoryUrl: null,
    headSha: null,
    installability: null,
    category: null,
    system: false,
    installed: true,
    enabled: true,
    scope: null,
    ui: [],
    cards: [CARD],
    ...overrides,
  };
}

function fakeClient(plugins: unknown) {
  const request = vi.fn(async () => ({ plugins }));
  return { request } as unknown as Parameters<typeof loadPluginCards>[0];
}

function sequencedClient(responses: Array<unknown | Error>) {
  let index = 0;
  const request = vi.fn(async () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  return { request } as unknown as Parameters<typeof loadPluginCards>[0];
}

describe("插件声明式卡片：已启用才出现", () => {
  it("只收集已安装且已启用条目的卡片", () => {
    const enabled = collectPluginCards([marketEntry()]);
    expect(enabled).toEqual([CARD]);
    expect(collectPluginCards([marketEntry({ enabled: false })])).toEqual([]);
    expect(collectPluginCards([marketEntry({ installed: false })])).toEqual([]);
  });

  it("列表格式不符时保留空卡片并记录原因", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadPluginCards(fakeClient([{ id: 1 }]));
    expect(findPluginCard("demo_echo")).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[code-ui] 插件卡片声明读取失败：",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("启动读取后按工具名命中，未声明的工具回退", async () => {
    await loadPluginCards(fakeClient([marketEntry()]));
    const context = (toolName: string) =>
      ({ toolCallNode: { toolCall: { toolName } } }) as never;
    expect(pluginCardRenderer.matches(context("demo_echo"))).toBe(true);
    expect(pluginCardRenderer.matches(context("other_tool"))).toBe(false);
    expect(findPluginCard(null)).toBeNull();
  });
});

describe("插件声明式卡片：库存变化即时生效", () => {
  it("停用的插件启用后重读，卡片立即可用", async () => {
    await loadPluginCards(fakeClient([marketEntry({ enabled: false })]));
    expect(findPluginCard("demo_echo")).toBeNull();
    await loadPluginCards(fakeClient([marketEntry()]));
    expect(findPluginCard("demo_echo")).toEqual(CARD);
  });

  it("启用的插件停用后重读，卡片立即移除", async () => {
    await loadPluginCards(fakeClient([marketEntry()]));
    expect(findPluginCard("demo_echo")).toEqual(CARD);
    await loadPluginCards(fakeClient([marketEntry({ enabled: false })]));
    expect(findPluginCard("demo_echo")).toBeNull();
    expect(
      pluginCardRenderer.matches({
        toolCallNode: { toolCall: { toolName: "demo_echo" } },
      } as never),
    ).toBe(false);
  });

  it("重读失败保留旧快照并记录原因", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadPluginCards(fakeClient([marketEntry()]));
    await loadPluginCards(sequencedClient([new Error("网络不可达")]));
    expect(findPluginCard("demo_echo")).toEqual(CARD);
    expect(warn).toHaveBeenCalledWith(
      "[code-ui] 插件卡片声明读取失败：",
      expect.any(Error),
    );
    warn.mockRestore();
  });
});

describe("插件声明式卡片：纯文本渲染数据", () => {
  it("标题、状态与键值行按声明显示，值只作为文本", () => {
    const view = pluginCardView(CARD);
    expect(view.kindLabel).toBe("成功");
    expect(view.title).toBe("插件执行结果");
    expect(view.rows.map((row) => [row.label, row.value])).toEqual([
      ["输入", "<b>hello</b>"],
      ["耗时毫秒", "12"],
    ]);
  });

  it("没有状态标记时显示插件卡片标签", () => {
    expect(pluginCardView({ ...CARD, status: null }).kindLabel).toBe(
      "插件卡片",
    );
  });
});
