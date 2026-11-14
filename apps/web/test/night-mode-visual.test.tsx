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
const source = (rel: string) =>
  readFileSync(path.join(ROOT, "src", rel), "utf8");

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
    const resolver = source(
      "components/workbench/zcode/lib/pluginIconSource.ts",
    );
    expect(resolver, "官方图标应指向线稿 SVG").toContain("documents.svg");
    expect(resolver, "不应残留实心 PNG 图标").not.toContain(".png");
  });

  it("深色首屏：缓存深色或系统深色都直接落 dark", () => {
    expect(resolveBootTheme("dark", null, false)).toBe("dark");
    expect(resolveBootTheme(null, "zai-dark", false)).toBe("dark");
    expect(resolveBootTheme("system", null, true)).toBe("dark");
    expect(THEME_BOOTSTRAP_SCRIPT).toContain('localStorage.getItem("theme")');
    expect(THEME_BOOTSTRAP_SCRIPT).toContain(
      'localStorage.getItem("zcode-theme")',
    );
    expect(THEME_BOOTSTRAP_SCRIPT).toContain("#0a0a0a");
  });

  it("浅色回归：缓存浅色或系统浅色保持 light", () => {
    expect(resolveBootTheme("light", null, true)).toBe("light");
    expect(resolveBootTheme(null, "zai-light", true)).toBe("light");
    expect(resolveBootTheme("system", "zai-light", true)).toBe("light");
    expect(THEME_BOOTSTRAP_SCRIPT).toContain("#ffffff");
  });

  it("显式选择优先于 system：next-themes 的 system 不能盖掉 iframe 的深色缓存", () => {
    expect(resolveBootTheme("system", "zai-dark", false)).toBe("dark");
    expect(resolveBootTheme("system", "light", true)).toBe("light");
    expect(resolveBootTheme("system", null, true)).toBe("dark");
    expect(resolveBootTheme("system", null, false)).toBe("light");
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

  it("深色品牌标是纯白剪影，两套样式表口径一致", () => {
    for (const rel of [
      "app/globals.css",
      "components/workbench/zcode/styles.css",
    ]) {
      const css = source(rel);
      const darkRule = css.slice(
        css.indexOf(".dark .brand-mark {"),
        css.indexOf("}", css.indexOf(".dark .brand-mark {")),
      );
      expect(darkRule, `${rel} 深色 logo 必须纯白`).toContain(
        "brightness(0) invert(1)",
      );
      expect(darkRule, `${rel} 不应给 logo 染色`).not.toContain("hue-rotate");
      expect(css, `${rel} 彩色 logo 在深色下也要转白`).toContain(
        ".dark .brand-mark-on-dark",
      );
    }
  });

  it("对话面板背景的半个 K 是线稿，不再有暗色实心剪影", () => {
    const tsx = source(
      "components/workbench/zcode/v4/ConversationDraftEmptyState.tsx",
    );
    expect(tsx).toContain('data-v4-draft-logo="outline"');
    expect(tsx).not.toContain('data-v4-draft-logo="dark"');
    expect(tsx).not.toContain("brightness-0 invert");
    expect(tsx).toContain("feMorphology");
    expect(tsx).toContain('floodColor="currentColor"');

    const css = source("components/workbench/zcode/styles.css");
    expect(css).toContain('[data-v4-draft-logo="outline"]');
    expect(css).toContain('.dark [data-v4-draft-logo="outline"]');
  });
});
