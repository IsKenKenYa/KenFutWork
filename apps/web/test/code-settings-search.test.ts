import { expect, it } from "vitest";
import {
  matchesSettingsNavigation,
  settingsNavigationSearchKeys,
} from "../src/components/workbench/zcode/settings-search/settingsNavigationSearch.js";

it.each([
  "界面字号",
  "jiemianzihao",
  "jmzh",
  "UI FONT",
  "ＵＩ　ＦＯＮＴ",
  "uifs",
])("设置标签可用中文、拼音或英文查询：%s", (query) => {
  const keys = settingsNavigationSearchKeys(["界面字号", "UI font size"]);
  expect(matchesSettingsNavigation(query, keys)).toBe(true);
});

it.each(["字号界面", "zihaojiemian", "uifsx", "ui.*", "[]"])(
  "查询保持字符顺序和普通文本含义：%s",
  (query) => {
    const keys = settingsNavigationSearchKeys(["界面字号", "UI font size"]);
    expect(matchesSettingsNavigation(query, keys)).toBe(false);
  },
);

it("空查询显示当前可用标签，空标签不匹配非空查询", () => {
  expect(matchesSettingsNavigation("  ", [])).toBe(true);
  expect(
    matchesSettingsNavigation("字体", settingsNavigationSearchKeys([])),
  ).toBe(false);
});
