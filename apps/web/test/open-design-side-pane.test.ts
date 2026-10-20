// 经 `@zui/*` 引用移植区模块（与仓库其它 web 测试同口径）：类型走 dist-types、
// 运行时走 vitest 别名；直接相对 import 源码会把 zcode 目录拉进 web 的 program，
// 而 apps/web/tsconfig.json 明确 exclude 了它。
import { resolveOpenTabLauncherItemIds } from "@zui/app-shell/animatedSidePanePanelModel";
import {
  getLocalizedSidePaneTabTitle,
  getSidePaneTabSearchHint,
  getSidePaneTabTypeLabel,
  type SidePaneTabPresentationLabels,
} from "@zui/app-shell/sidePaneTabPresentation";
import {
  applyBrowserUseSidePaneEvent,
  getActiveSidePaneTab,
  getVisibleSidePaneTabs,
  type OpenDocumentSidePaneRequest,
  openBrowserSidePane,
  openDocumentSidePane,
  openOpenDesignSidePane,
  preserveDocumentSidePaneForAutomaticEvent,
  updateOpenDesignSidePaneTab,
  resolveSidePaneScopeState,
  stampSidePaneTabsOwnership,
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

test("一块画布一个标签：同项目复用，不同项目各开一个", () => {
  const first = openOpenDesignSidePane(null, { projectId: "p-1", title: "登录页" });
  expect(first.tabs).toHaveLength(1);
  expect(first.tabs[0]?.type).toBe("open-design");
  expect(first.activeTabId).toBe("open-design:p-1");
  expect(first.tabs[0]?.projectId).toBe("p-1");

  const again = openOpenDesignSidePane(first, { projectId: "p-1" });
  expect(again.tabs).toHaveLength(1);

  const second = openOpenDesignSidePane(again, { projectId: "p-2", title: "订单页" });
  expect(second.tabs).toHaveLength(2);
  expect(getActiveSidePaneTab(second)?.id).toBe("open-design:p-2");
});

test("未绑定的旧标签照旧可开（面板自行解析最近画布），画布名按标签回写", () => {
  const opened = openOpenDesignSidePane(null);
  expect(opened.tabs[0]?.id).toBe("open-design");
  expect(opened.tabs[0]?.projectId).toBeNull();

  const titled = updateOpenDesignSidePaneTab(opened, "open-design", {
    projectId: "p-9",
    title: "登录页",
  });
  expect(getActiveSidePaneTab(titled)?.title).toBe("登录页");
  expect(getActiveSidePaneTab(titled)?.projectId).toBe("p-9");
  // 打偏的 tab id 不产生新状态（引用不变）。
  expect(
    updateOpenDesignSidePaneTab(opened, "open-design:missing", { title: "x" }),
  ).toBe(opened);
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

const CANVAS_REQUEST: OpenDocumentSidePaneRequest & { workspaceKey: string } = {
  resourceType: "canvas",
  projectId: "project-a",
  documentId: "canvas-a",
  title: "画布 A",
  workspaceKey: "workspace-a",
};

test("OpenDesign 与项目画布共存，重复打开和显式切换不丢失画布", () => {
  const document = openDocumentSidePane(null, CANVAS_REQUEST);
  const withOpenDesign = openOpenDesignSidePane(document);
  const reopened = openOpenDesignSidePane(withOpenDesign);
  expect(reopened.tabs.map((tab) => tab.type)).toEqual([
    "document",
    "open-design",
  ]);
  expect(getActiveSidePaneTab(reopened)?.type).toBe("open-design");
  expect(reopened.tabs[0]).toBe(document.tabs[0]);

  const canvas = openDocumentSidePane(reopened, CANVAS_REQUEST);
  expect(canvas.tabs).toHaveLength(2);
  expect(canvas.activeTabId).toBe(document.activeTabId);
  expect(
    canvas.tabs.map((tab) => getLocalizedSidePaneTabTitle(tab, LABELS)),
  ).toEqual(["画布 A", "OpenDesign"]);
  expect(
    canvas.tabs.map((tab) => getSidePaneTabTypeLabel(tab, LABELS)),
  ).toEqual(["画布", "OpenDesign"]);
  expect(canvas.tabs.map(getSidePaneTabSearchHint)).toEqual([
    "画布 A project-a canvas-a canvas document",
    "open design canvas prototype page dashboard export",
  ]);
});

test("OpenDesign 跨会话可见，项目画布的隔离与当前选中项保持有效", () => {
  const openDesign = stampSidePaneTabsOwnership(openOpenDesignSidePane(null), {
    ownerTaskId: "task-a",
    workspaceKey: "workspace-a",
  });
  const document = openDocumentSidePane(openDesign, CANVAS_REQUEST);
  const scope = {
    workspaceKey: "workspace-a",
    projectId: "project-a",
    ownerTaskId: "task-b",
  };
  expect(
    getVisibleSidePaneTabs(document.tabs, scope).map((tab) => tab.type),
  ).toEqual(["open-design", "document"]);
  expect(
    resolveSidePaneScopeState(document, scope, "open-design").sidePaneState
      ?.activeTabId,
  ).toBe(document.activeTabId);
  expect(
    getVisibleSidePaneTabs(document.tabs, {
      ...scope,
      projectId: "project-b",
    }).map((tab) => tab.type),
  ).toEqual(["open-design"]);
  expect(
    getVisibleSidePaneTabs(document.tabs, {
      ...scope,
      workspaceKey: "workspace-b",
    }),
  ).toEqual([]);
});

test("同时保留 OpenDesign 时，浏览器自动事件仍不抢占当前画布", () => {
  const document = openDocumentSidePane(
    openOpenDesignSidePane(null),
    CANVAS_REQUEST,
  );
  const browser = applyBrowserUseSidePaneEvent(
    document,
    { workspaceKey: "workspace-a", sessionId: "task-a", tabId: "browser-a" },
    { workspaceKey: "workspace-a", ownerTaskId: "task-a" },
  );
  const preserved = preserveDocumentSidePaneForAutomaticEvent(
    document,
    browser.state,
    {
      projectId: "project-a",
      workspaceKey: "workspace-a",
    },
  );
  expect(preserved?.activeTabId).toBe(document.activeTabId);
  expect(preserved?.tabs.map((tab) => tab.type)).toEqual([
    "open-design",
    "document",
    "browser-use",
  ]);
  expect(getActiveSidePaneTab(openOpenDesignSidePane(preserved))?.type).toBe(
    "open-design",
  );
});
