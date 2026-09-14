import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * UI 文案汉化守卫（画布与对话区）。
 *
 * 背景：画布/对话区曾混着英文文案——Excalidraw 原生 chrome 因未指定 `langCode`
 * 默认英文（右键菜单、缩放、帮助），我们自绘的按钮也留着英文 title/aria-label，
 * 用户直接看到「汉化不彻底」。
 *
 * 这是**显式禁列**而非通用本地化 linter：只锁已修的那批串，避免误报。
 * 新增界面文案时若真要用英文（如 Beta 借用词），不要往这里加噪音——
 * 先确认它是有意的品牌/术语。
 */
const ROOT = join(import.meta.dirname, "..", "src", "components");

const FILES = [
  "canvas-editor.tsx",
  "canvas-ai-toolbar.tsx",
  "canvas-bottom-bar.tsx",
  "canvas-files-panel.tsx",
  "canvas-image-gen-panel.tsx",
  "canvas-layers-panel.tsx",
  "canvas-empty-hint.tsx",
  "canvas-tool-menu.tsx",
  "chat-input.tsx",
  "chat-sidebar.tsx",
  "session-selector.tsx",
  join("canvas", "image-generator-panel.tsx"),
  join("canvas", "video-generator-panel.tsx"),
  join("brand-kit", "brand-kit-editor.tsx"),
  join("brand-kit", "brand-kit-sidebar.tsx"),
  join("brand-kit", "color-section.tsx"),
  join("brand-kit", "font-section.tsx"),
  join("brand-kit", "image-section.tsx"),
  join("brand-kit", "logo-section.tsx"),
  join("brand-kit", "guidance-section.tsx"),
  join("brand-kit", "color-picker-popover.tsx"),
  join("brand-kit", "empty-state.tsx"),
];

/** 已汉化的英文串（出现即回归）。 */
const FORBIDDEN = [
  'title="AI Image"',
  'title="AI Video"',
  ">AI Image<",
  'aria-label="Background color"',
  'aria-label="Generated files"',
  'aria-label="Close color picker"',
  'aria-label="Close files panel"',
  'aria-label="Close layers panel"',
  'aria-label="Lock layer"',
  'aria-label="Toggle layer visibility"',
  'title="Remove mention"',
  'title="Attach images"',
  'title="Image model"',
  'title="Collapse panel"',
  'aria-label="Resize chat panel"',
  'title="Add reference image"',
  'placeholder="Describe the image you want to create..."',
  "selected on canvas",
  'placeholder="Kit name"',
  'aria-label="More actions"',
  ">Brand Kit<",
  'placeholder="Color name"',
  'title="Colors"',
  'title="Fonts"',
  'title="Images"',
  'title="Logos"',
  'title="Brand Guidance"',
  'aria-label="Add color"',
  'aria-label="Add font"',
  'label="Upload"',
  "No brand kits yet",
  "Create Brand Kit",
];

describe("画布与对话区文案已汉化", () => {
  it("禁列里的英文串不出现在画布/对话/品牌套件组件中", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const content = readFileSync(join(ROOT, file), "utf-8");
      for (const needle of FORBIDDEN) {
        if (content.includes(needle)) {
          offenders.push(`${file}: ${needle}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("Excalidraw 指定了中文语言（原生 chrome 不指定即英文）", () => {
    const content = readFileSync(join(ROOT, "canvas-editor.tsx"), "utf-8");
    expect(content).toContain('langCode="zh-CN"');
  });
});
