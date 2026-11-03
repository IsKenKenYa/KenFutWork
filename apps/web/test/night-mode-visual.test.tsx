// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingScreen } from "../src/components/loading-screen";
import {
  resolveBootTheme,
  THEME_BOOTSTRAP_SCRIPT,
} from "../src/lib/theme-bootstrap";

/**
 * 夜间模式视觉回归：线稿图标、深色首屏、浅色不被带坏。
 * 视觉类改动没有像素断言，这里锁住「选择」本身：
 * 打包图标必须是 stroke 线稿、首帧解析必须先落深色、加载屏只跟随主题 token。
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (rel: string) => readFileSync(path.join(ROOT, "src", rel), "utf8");

const STROKE_PLUGIN_ICONS = [
  "documents",
  "image-search",
  "pdf",
  "plugin-creator",
  "presentations",
  "spreadsheets",
] as const;

describe("夜间模式视觉", () => {
  it("官方插件图标走线稿，且中灰描边在深浅两种底色上都能读", () => {
    for (const name of STROKE_PLUGIN_ICONS) {
      const svg = source(
        `components/workbench/zcode/assets/plugin-icons/${name}.svg`,
      );
      expect(svg, `${name} 应为无填充线稿`).toContain('fill="none"');
      expect(svg, `${name} 缺少描边色`).toContain('stroke="#8a8a8a"');
      expect(svg, `${name} 不应靠填充块撑可视`).not.toMatch(
        /fill="(?:#fff|#ffffff|white|currentColor)"/i,
      );
    }
    const resolver = source("components/workbench/zcode/lib/pluginIconSource.ts");
    expect(resolver, "官方图标应指向线稿 SVG").toContain("documents.svg");
    expect(resolver, "不应残留实心 PNG 图标").not.toContain(".png");
  });

  it("深色首屏：缓存深色或系统深色都直接落 dark", () => {
    expect(resolveBootTheme("dark", null, false)).toBe("dark");
    expect(resolveBootTheme(null, "zai-dark", false)).toBe("dark");
    expect(resolveBootTheme("system", null, true)).toBe("dark");
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('localStorage.getItem("theme")');
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('localStorage.getItem("zcode-theme")');
    expect(THEME_BOOTSTRAP_SCRIPT).toContain("#0a0a0a");
  });

  it("浅色回归：缓存浅色或系统浅色保持 light", () => {
    expect(resolveBootTheme("light", null, true)).toBe("light");
    expect(resolveBootTheme(null, "zai-light", true)).toBe("light");
    expect(resolveBootTheme("system", "zai-dark", false)).toBe("light");
    expect(THEME_BOOTSTRAP_SCRIPT).toContain("#ffffff");
  });

  it("加载屏跟随主题背景与品牌标，不写死白底", () => {
    const { container } = render(<LoadingScreen label="加载中" />);
    const status = container.querySelector('[role="status"]');
    expect(status?.className).toContain("bg-background");
    expect(status?.className).not.toContain("bg-white");

    const logo = container.querySelector("img");
    expect(logo?.className).toContain("brand-mark");
    expect(logo?.className).not.toContain("dark:invert");
  });
});
