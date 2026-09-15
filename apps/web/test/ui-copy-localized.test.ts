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
  "side-panel-tabs.tsx",
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
  "Fit All",
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

/**
 * 画布右键菜单：无用项隐藏 + 网格入口自绘中文。
 *
 * 背景：Excalidraw 自带的 zh-CN 语言包缺 `toggleGrid`/`fullTitle`/
 * `copyElementLink`/`linkToElement`/`wrapSelectionInFrame` 等键，这些项必然回落
 * 英文（且 Excalidraw 未导出 setLanguage、也无自定义语言对象入参，配置层修不了）。
 * 处理方式是按 action 名隐藏，并为我们想保留的能力（网格）自绘中文入口。
 */
describe("画布右键菜单：无关项按 action 名隐藏", () => {
  /** Excalidraw 菜单项 li 上带 data-testid={actionName}。 */
  const HIDDEN_ACTIONS = [
    "zenMode", // 禅模式（用户点名移除）
    "viewMode", // 查看模式（用户点名移除）
    "linkToElement", // Add link / Link to object（英文 + 小众）
    "copyElementLink", // Copy link to object（英文 + 小众）
    "wrapSelectionInFrame", // Wrap selection in frame（英文）
    "toggleLinearEditor", // 编辑箭头（labels.lineEditor.editArrow 缺中文键；Enter/双击仍可编辑）
  ];

  it("隐藏规则覆盖全部目标动作（避免升级依赖后静默回退）", () => {
    const css = readFileSync(join(ROOT, "..", "app", "globals.css"), "utf-8");
    for (const action of HIDDEN_ACTIONS) {
      expect(css, action).toContain(
        `.context-menu li[data-testid="${action}"]`,
      );
    }
  });

  it("保留项的中文标签覆盖存在（gridMode/stats 语言包缺键，用 CSS 兜）", () => {
    const css = readFileSync(join(ROOT, "..", "app", "globals.css"), "utf-8");
    expect(css).toContain(
      'li[data-testid="gridMode"] .context-menu-item__label',
    );
    expect(css).toContain('"显示/隐藏网格"');
    expect(css).toContain('li[data-testid="stats"] .context-menu-item__label');
    expect(css).toContain('"画布与元素属性"');
    // 这两项不得再被隐藏（用户要求保留）
    expect(css).not.toContain('.context-menu li[data-testid="gridMode"],');
    expect(css).not.toContain('.context-menu li[data-testid="stats"],');
  });

  it("画布菜单样式与应用内菜单一致（字体/卡片底/hover 色/圆角）", () => {
    const css = readFileSync(join(ROOT, "..", "app", "globals.css"), "utf-8");
    // 与应用内菜单同源的设计 token
    expect(css).toContain("font-family: var(--font-sans");
    expect(css).toContain("background-color: var(--card)");
    // 选中态：主色底 + 文字变白（与应用内菜单同款；Excalidraw 原生只改文字色）
    expect(css).toContain("background-color: var(--primary)");
    expect(css).toContain("color: var(--primary-foreground)");
    // 全站文字选中同样是主色底 + 主色前景（输入框选中文字会变白）
    expect(css).toContain("::selection {");
    expect(css).toContain(".excalidraw .context-menu .context-menu-item:hover");
    expect(css).toContain(".excalidraw .context-menu.context-menu {");
    expect(css).toContain("border-radius: 0.5rem");
  });

  it("网格能力仍可用：底部栏有中文「网格」开关（第二种便捷入口）", () => {
    const bar = readFileSync(join(ROOT, "canvas-bottom-bar.tsx"), "utf-8");
    expect(bar).toContain('aria-label="网格"');
    expect(bar).toContain("gridSize");
    // 不把 Excalidraw 的英文文案渲染成界面标签（注释里提到它不算违规）
    expect(bar).not.toContain('aria-label="Toggle grid"');
    expect(bar).not.toContain('title="Toggle grid"');
  });
});
