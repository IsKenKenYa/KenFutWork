import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { SIDE_PANE_DEFAULT_EXPANDED_RATIO } from "../src/components/workbench/zcode/app-shell/sidePaneLayout";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const shellLayout = read(
  "../src/components/workbench/zcode/app-shell/WorkspaceShellLayout.tsx",
);
const app = read("../src/components/workbench/zcode/App.tsx");
const useAppPanels = read(
  "../src/components/workbench/zcode/hooks/useAppPanels.ts",
);
const panelModel = read(
  "../src/components/workbench/zcode/app-shell/animatedSidePanePanelModel.ts",
);

/**
 * 侧栏收起态 rail 承载全部入口（插件市场·技能·MCP·米家·智能家居·新建任务·搜索，
 * 实测 10 个 32×32 图标），所以「收起」不再等于「丢入口」。允许的程序化收起只有一种：
 * 进入 Design 把宽度让给画布（用户 2026-10-20 口径），且必须有 rail 存活。
 * 其余两条历史触发点（右栏拖到宽度上限收左栏、conversation 过窄收左栏）不得回来——
 * 它们会在用户没有表达意图时收起侧栏（2026-10-19 用户两次反馈的直接原因）。
 */
test("壳层不得程序化收起左侧栏", () => {
  expect(shellLayout).not.toMatch(/handleToggleSidebar\s*\(/);
  expect(shellLayout).not.toMatch(/onSidePaneReachMaxSize/);
  expect(useAppPanels).not.toMatch(/setIsSidebarVisible\(\s*false\s*\)/);
});

test("只有 Design 视图可以自动收起，且必须有 rail 兜底", () => {
  const effect = app.slice(
    app.indexOf("sidebarRailsWhenCollapsed"),
    app.indexOf("const [openAutomationId"),
  );
  expect(effect).toContain('workspaceMainView === "design"');
  expect(effect).toContain("sidebarRailsWhenCollapsed");
  // 桌面 chrome 收起会连 aside 一起隐藏，模式切换器没有落点
  expect(effect).toContain("!isDesktop && !isMacDesktop && !isWindowsDesktop");
  expect(app.match(/setIsSidebarVisible\(false\)/g)).toHaveLength(1);
});

test("侧栏收起入口只有手动开关与快捷键", () => {
  expect(useAppPanels).toMatch(
    /setIsSidebarVisible\(\(visible\) => !visible\)/,
  );
});

test("分栏默认口径 = 对话 1 : 内容面 2（用户 2026-10-20 口径）", () => {
  expect(SIDE_PANE_DEFAULT_EXPANDED_RATIO).toBeCloseTo(2 / 3, 6);
  // 内容面上限必须高于默认口径，否则 2/3 会被夹回去
  expect(
    Number.parseFloat(/maxSize:\s*"([\d.]+)%"/u.exec(panelModel)?.[1] ?? "0"),
  ).toBeGreaterThan(SIDE_PANE_DEFAULT_EXPANDED_RATIO * 100);
});
