import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 界面文案硬约束守卫（《AGENTS.md》「界面文案（硬约束）」，用户口径 2026-09-27）。
 *
 * 背景：语音设置页曾把方案文档整段抄进界面（「松开后把文字填进输入框，你自己确认再发送」、
 * 「预估：本机 CPU 实时率约 0.1–0.7（首次调用含模型载入会更慢）」），用户原话
 * 「根本不是给人看的」「我给你描述的是需求，而不是让你原原本本写上去」。
 *
 * 这是**机械门禁**（不是提醒）：扫设置区源码里的 JSX 文本，凡出现 ①句子标点（。；）
 * 或 ②超过 40 字的整句，即判违约。
 *
 * 判定刻意收窄以免误伤：
 * - 只扫设置区文件（用户点名的范围）；
 * - 注释整行跳过（说明留在代码里是对的）；
 * - 先把字符串字面量剥掉——**报错信息是硬约束的例外**（`message: "保存失败。"` 合法），
 *   而 JSX 文本不在引号里，正好区分开；
 * - 只认含中文的行：纯代码/类型/属性行不含中文，天然被排除。
 */

const COMPONENTS = join(import.meta.dirname, "..", "src", "components");
const CJK = /[\u4e00-\u9fff]/;

/** 设置区文件清单（设置弹窗本身 + 各 section）。 */
function settingsFiles(): string[] {
  const files: string[] = [];
  for (const dir of [COMPONENTS, join(COMPONENTS, "workbench")]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".tsx")) continue;
      if (!/section|settings-modal/.test(entry.name)) continue;
      files.push(join(dir, entry.name));
    }
  }
  return files.sort();
}

/** 剥掉字符串字面量与模板串，只留 JSX 文本/结构。 */
function stripStringLiterals(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/** 纯注释行（// 行、块注释续行、JSX 注释起始）。 */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("{/*")
  );
}

/**
 * 这一行是否像 **JSX 文本子节点**：含中文，且剥掉字符串后不含代码形状
 * （`=` `;` `{` `}` `(` `)` `<>` `[` `]` `:`）。TS 语句、JSX 属性、类型声明都被排除。
 */
function looksLikeJsxText(line: string): boolean {
  const text = stripStringLiterals(line);
  if (!CJK.test(text)) return false;
  if (/[=;{}()[\]<>:]/.test(text)) return false;
  return true;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of settingsFiles()) {
    const lines = readFileSync(file, "utf-8").split(/\r?\n/);
    lines.forEach((raw, index) => {
      if (isComment(raw) || !looksLikeJsxText(raw)) return;
      const text = stripStringLiterals(raw).trim();
      if (text.length === 0) return;
      if (/[。；]/.test(text) || text.length > 40) {
        violations.push({
          file: file.slice(file.indexOf("components")),
          line: index + 1,
          text: text.slice(0, 60),
        });
      }
    });
  }
  return violations;
}

/** 只装文本的元素——它们空着一定是文案被删剩的壳 */
const TEXT_TAGS = "p|span|li|dd|dt";
const EMPTY_INLINE = new RegExp(`<(${TEXT_TAGS})\\b[^>]*>\\s*</\\1>`);
const OPEN_TEXT_TAG = new RegExp(`^<(${TEXT_TAGS})\\b[^>]*>$`);
const CLOSE_TEXT_TAG = new RegExp(`^</(${TEXT_TAGS})>$`);

/**
 * 被掏空的文本元素（`<p className="mb-6"></p>`）。
 *
 * 背景：2026-09-27 用户口径要求把设置区文案精简到极致，删句子时留下了空壳——
 * 元素本身没了内容，`className` 上的 `mb-*` / `mt-*` 边距却还在，界面于是出现
 * 用户点名的「排版很不合理」大片空白（一次清掉 12 处）。空壳没有任何合法用途。
 */
function findEmptyShells(): Violation[] {
  const violations: Violation[] = [];
  for (const file of settingsFiles()) {
    const lines = readFileSync(file, "utf-8").split(/\r?\n/);
    lines.forEach((raw, index) => {
      const line = raw.trim();
      if (EMPTY_INLINE.test(line)) {
        violations.push({
          file: file.slice(file.indexOf("components")),
          line: index + 1,
          text: line.slice(0, 60),
        });
        return;
      }
      const open = OPEN_TEXT_TAG.exec(line);
      if (!open) return;
      // 跨行空壳：`<p …>` 后面紧跟（跳过空行）就是 `</p>`
      const rest = lines.slice(index + 1).filter((l) => l.trim().length > 0);
      if (rest.length > 0 && CLOSE_TEXT_TAG.test((rest[0] ?? "").trim())) {
        violations.push({
          file: file.slice(file.indexOf("components")),
          line: index + 1,
          text: line.slice(0, 60),
        });
      }
    });
  }
  return violations;
}

describe("界面文案硬约束：设置区只写标签，不写句子", () => {
  it("没有句子标点、没有超过 40 字的整句", () => {
    const violations = findViolations();
    const rendered = violations
      .map((v) => `  ${v.file}:${v.line}  「${v.text}」`)
      .join("\n");
    expect(
      violations.length,
      `设置区出现疑似说明句（只写标签；说明放 docs 或代码注释）：\n${rendered}`,
    ).toBe(0);
  });

  /**
   * 机械门禁：文案删干净、壳也要删干净。空壳留着会以边距的形式变成可见的排版事故，
   * 而看源码时它几乎不可见——正是需要机器盯的那类残留。
   */
  it("没有删文案剩下的空元素（空壳会留出死空白）", () => {
    const shells = findEmptyShells();
    const rendered = shells
      .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
      .join("\n");
    expect(
      shells.length,
      `设置区有空文本元素（删文案时请连元素一起删）：\n${rendered}`,
    ).toBe(0);
  });

  it("守卫自身有效：认出塞回来的说明句，放过报错文案与代码行", () => {
    expect(
      looksLikeJsxText("        松开后把文字填进输入框，你自己确认再发送。"),
    ).toBe(true);
    // 报错文案在字符串里：剥掉字符串后没有中文可判（硬约束的例外）
    expect(looksLikeJsxText('        message: "保存失败。",')).toBe(false);
    // 代码行（含 = 与引号）不会被误判成界面文案
    expect(
      looksLikeJsxText('        const [value, setValue] = useState("");'),
    ).toBe(false);
  });

  it("空壳守卫自身有效：认出两种空壳，放过有内容的元素与自闭合的图标", () => {
    expect(EMPTY_INLINE.test('<p className="mb-6 text-sm"></p>')).toBe(true);
    expect(EMPTY_INLINE.test("<span></span>")).toBe(true);
    // 有内容的不算
    expect(EMPTY_INLINE.test("<p>没有钩子</p>")).toBe(false);
    // 自闭合的图标/输入框是正常的，不该误伤
    expect(EMPTY_INLINE.test('<Icon className="h-4 w-4" />')).toBe(false);
    expect(EMPTY_INLINE.test('<input type="radio" />')).toBe(false);
    // 跨行空壳靠 OPEN_TEXT_TAG + 下一行闭合判定
    expect(OPEN_TEXT_TAG.test('<p className="text-sm">')).toBe(true);
    expect(CLOSE_TEXT_TAG.test("</p>")).toBe(true);
    expect(CLOSE_TEXT_TAG.test("</span>")).toBe(true);
    // 容器标签不在清单里：空的 <div> 有时是布局占位，不算「删文案剩的壳」
    expect(EMPTY_INLINE.test('<div className="mt-3"></div>')).toBe(false);
  });
});
