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

/**
 * 侧栏收起态 rail 只承载 logo／展开／模式三个图标，插件市场·技能·MCP·米家·智能家居·
 * 新建任务·搜索都没有落点，且桌面浮层的「新建任务」会压住 logo（用户 2026-10-19 口径）。
 * 在 rail 承载这些入口之前，任何代码都不得程序化收起左侧栏——只能由用户手动收起。
 */
test("壳层不得程序化收起左侧栏", () => {
  expect(shellLayout).not.toMatch(/handleToggleSidebar\s*\(/);
  expect(app).not.toMatch(/setIsSidebarVisible/);
  expect(useAppPanels).not.toMatch(/setIsSidebarVisible\(\s*(false|!)/);
});

test("侧栏收起入口只有手动开关与快捷键", () => {
  expect(useAppPanels).toMatch(/setIsSidebarVisible\(\(visible\) => !visible\)/);
});

test("分栏默认口径仍是对话 1/3、内容面 2/3", () => {
  expect(SIDE_PANE_DEFAULT_EXPANDED_RATIO).toBeCloseTo(0.64, 5);
});
