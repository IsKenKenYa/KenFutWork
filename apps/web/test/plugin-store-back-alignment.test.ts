import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

/**
 * 插件市场顶部返回钮的光学对齐守卫：`size="icon-lg"` 是 32px 盒，居中后 16px 箭头的
 * 墨迹落在内容列左边缘右侧 10.7px，与下方头像/标题不同线（实测截图口径）。
 */
it("插件市场返回钮带光学左移，箭头与内容列同线", () => {
  const source = readFileSync(
    "src/components/workbench/zcode/settings/PluginStorePage.tsx",
    "utf-8",
  );
  const backButton = source.match(/<Button[^>]*onClick=\{onBack\}/u)?.[0];
  expect(backButton).toBeDefined();
  expect(backButton).toContain("-ml-2.5");
});
