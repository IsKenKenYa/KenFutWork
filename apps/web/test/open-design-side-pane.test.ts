// 经 `@zui/*` 引用移植区模块（与仓库其它 web 测试同口径）：类型走 dist-types、
// 运行时走 vitest 别名；直接相对 import 源码会把 zcode 目录拉进 web 的 program，
// 而 apps/web/tsconfig.json 明确 exclude 了它。
import {
  resolveOpenDesignNavigateSource,
  resolveOpenTabLauncherItemIds,
} from "@zui/app-shell/animatedSidePanePanelModel";
import {
  getLocalizedSidePaneTabTitle,
  type SidePaneTabPresentationLabels,
} from "@zui/app-shell/sidePaneTabPresentation";
import {
  getActiveSidePaneTab,
  openBrowserSidePane,
  openOpenDesignSidePane,
} from "@zui/lib/workspaceSidePane";
import { expect, test } from "vitest";

/**
 * OpenDesign 右侧栏（O0）的模型层行为。
 *
 * 入口纪律：OpenDesign 以插件形态交付，**未安装插件或宿主未就绪时不出现入口**
 * （不摆空壳、不放假开关）——所以启动卡默认不出现，只有显式 enable 才出现。
 */

test("OpenDesign 启动卡缺省不出现，显式 enable 才出现（不摆空壳）", () => {
  const withoutFlag = resolveOpenTabLauncherItemIds({
    developerToolsEnabled: false,
    hasReviewTab: false,
  });
  expect(withoutFlag).not.toContain("open-design");
  // 反向断言：别的项照旧在，证明不是「整个列表为空」造成的假通过。
  expect(withoutFlag).toContain("terminal");

  const withFlag = resolveOpenTabLauncherItemIds({
    developerToolsEnabled: false,
    hasReviewTab: false,
    openDesignEnabled: true,
  });
  expect(withFlag).toContain("open-design");
});

test("open-design 是单例 tab：重复打开只激活同一个，不叠出第二个", () => {
  const first = openOpenDesignSidePane(null);
  expect(first.tabs).toHaveLength(1);
  expect(first.tabs[0]?.type).toBe("open-design");
  expect(first.activeTabId).toBe("open-design");

  const second = openOpenDesignSidePane(first);
  expect(second.tabs).toHaveLength(1);
  expect(getActiveSidePaneTab(second)?.type).toBe("open-design");
});

test("open-design tab 可带深链目标；重复深链替换目标且仍是单例（O2 od/navigate）", () => {
  const first = openOpenDesignSidePane(null, {
    navigatePath: "src/app/page.tsx",
  });
  expect(getActiveSidePaneTab(first)).toMatchObject({
    type: "open-design",
    navigatePath: "src/app/page.tsx",
  });

  // 重复触发「在 OpenDesign 中打开」另一个文件：原地替换，不叠第二个面板，
  // 目标换成新文件（activateSidePaneTab 的既有语义）。
  const second = openOpenDesignSidePane(first, {
    navigatePath: "src/lib/other.ts",
  });
  expect(second.tabs).toHaveLength(1);
  expect(getActiveSidePaneTab(second)?.type).toBe("open-design");
  expect(
    (getActiveSidePaneTab(second) as { navigatePath?: string | null })
      .navigatePath,
  ).toBe("src/lib/other.ts");

  // 不带深链的普通打开：navigatePath 缺省（不残留上一个目标）。
  const plain = openOpenDesignSidePane(second);
  expect(
    (getActiveSidePaneTab(plain) as { navigatePath?: string | null })
      .navigatePath,
  ).toBeUndefined();
});

test("深链来源只认当前在看的 code-viewer；其它 tab / 空 / 无 path 都不给（不摆空开关）", () => {
  // 源码 / diff / 预览都是带 path 的 code-viewer——都算深链来源。
  expect(
    resolveOpenDesignNavigateSource({
      type: "code-viewer",
      source: { path: "src/a.ts" },
    }),
  ).toBe("src/a.ts");
  // code-viewer 但没 path（如目录态）：不给，菜单项不出现。
  expect(
    resolveOpenDesignNavigateSource({
      type: "code-viewer",
      source: { path: null },
    }),
  ).toBeNull();
  expect(
    resolveOpenDesignNavigateSource({ type: "code-viewer", source: {} }),
  ).toBeNull();
  // 在看的不是 code-viewer（浏览器 / git / open-design 自己…）：不给。
  expect(resolveOpenDesignNavigateSource({ type: "browser" })).toBeNull();
  expect(resolveOpenDesignNavigateSource(null)).toBeNull();
  expect(resolveOpenDesignNavigateSource(undefined)).toBeNull();
});

test("open-design 与浏览器面板同位互斥（单 activeTabId 语义）", () => {
  const withBrowser = openBrowserSidePane(null, { tabId: "browser-test" });
  expect(getActiveSidePaneTab(withBrowser)?.type).toBe("browser");

  const withOpenDesign = openOpenDesignSidePane(withBrowser);
  // 浏览器 tab 还在，但已失活——两者占同一个槽位，不可能同时激活。
  expect(withOpenDesign.tabs.map((tab) => tab.type)).toEqual([
    "browser",
    "open-design",
  ]);
  expect(getActiveSidePaneTab(withOpenDesign)?.type).toBe("open-design");
});

const LABELS: SidePaneTabPresentationLabels = {
  browserTitle: "浏览器",
  reviewTitle: "审查",
  codeViewerTitle: "代码",
  treemappingTitle: "文件活动",
  whiteboardTitle: "画板",
  openDesignTitle: "OpenDesign",
  modelTrajectoryTitle: "模型轨迹",
  developerToolsTitle: "开发者工具",
  terminalTitle: "终端",
  subagentTypeLabel: "子智能体",
  subagentDirectoryTitle: "子智能体目录",
  selectionChatTitle: "选区对话",
  planTitle: "计划",
  workflowRunTitle: "工作流运行",
  workflowDirectoryTitle: "工作流目录",
  workflowActorTitle: "工作流执行者",
  workflowScriptTitle: "工作流脚本",
  workflowArtifactTitle: "工作流产物",
};

test("open-design tab 有标题分派：不 fallthrough 到 tab.source（browser-use 崩过同一个坑）", () => {
  // 该 tab 没有 title / source 字段；若标题分派漏了 open-design 分支，
  // getSidePaneTabTitle 会落到 `tab.source.title` 读 undefined → 抛错。
  const tab = openOpenDesignSidePane(null).tabs[0];
  if (!tab) throw new Error("openOpenDesignSidePane 未产出 tab");
  expect(getLocalizedSidePaneTabTitle(tab, LABELS)).toBe("OpenDesign");
});
