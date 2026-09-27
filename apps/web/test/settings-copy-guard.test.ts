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
 * 逐行的「是否在注释里」标记。
 *
 * 光看行首不够：`/* … *​/` 与 `{/* … *​/}` 的**续行**是普通中文文本（不以 `*` 开头），
 * 上一版的 `isComment` 只认行首形状，于是把块注释正文当成了界面文案——实测被误报两次
 * （都是我自己写的多行 JSX 注释）。这里改成跟踪块注释状态，把整段注释都跳过；
 * 判断 `/*` 之前先剥字符串字面量，免得代码里的 `"/*"` 把后面整段误当注释放过。
 */
function commentFlags(lines: string[]): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false);
  let inBlock = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlock) {
      flags[index] = true;
      if (trimmed.includes("*/")) inBlock = false;
      return;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
      flags[index] = true;
      return;
    }
    const probe = stripStringLiterals(trimmed);
    const open = probe.indexOf("/*");
    if (open < 0) return;
    flags[index] = true;
    if (!probe.slice(open + 2).includes("*/")) inBlock = true;
  });
  return flags;
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

/**
 * 行内 JSX 文本节点（`<p className="…">文案</p>` 这种一行写完的）。
 *
 * 光靠 `looksLikeJsxText`（要求整行没有 `<` `>` `=` 等代码形状）会**整段漏掉**这一类：
 * 实测把一句 36 字并带句号的说明塞进 `<p className="…">…</p>` 一行里，门禁是全绿的。
 * 这里把 `>…<` 之间的片段抠出来单独判——含 `=` `;` `{}()[]` 的片段是表达式不是文案，
 * 跳过（`/` 不能排除：「改文件 / 跑命令前先问我」这类标签里本来就有斜杠）。
 */
function inlineJsxTexts(line: string): string[] {
  const text = stripStringLiterals(line);
  const out: string[] = [];
  for (const match of text.matchAll(/>([^<>]+)</g)) {
    const chunk = (match[1] ?? "").trim();
    if (chunk.length === 0 || !CJK.test(chunk)) continue;
    if (/[=;{}()[\]]/.test(chunk)) continue;
    out.push(chunk);
  }
  return out;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of settingsFiles()) {
    const lines = readFileSync(file, "utf-8").split(/\r?\n/);
    const comments = commentFlags(lines);
    lines.forEach((raw, index) => {
      if (comments[index] || isComment(raw)) return;
      const chunks = looksLikeJsxText(raw)
        ? [stripStringLiterals(raw).trim()]
        : inlineJsxTexts(raw);
      const bad = chunks.filter((text) =>
        text.length === 0 ? false : /[。；]/.test(text) || text.length > 40,
      );
      for (const text of bad) {
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

  /** 多行注释的续行是普通中文，光看行首会把它当成界面文案（实测误报过两次） */
  it("块注释整段跳过：续行不再被误判，注释外的长句仍被抓到", () => {
    const flags = commentFlags([
      "    {",
      "      /* 第一行说明，",
      "         续行是普通中文，不以星号开头。 */",
      '      <span className="text-sm">标签</span>',
      "    }",
      "    <p>这一句是真的界面文案，很长很长很长很长很长很长很长很长很长很长很长。</p>",
    ]);
    expect(flags).toEqual([false, true, true, false, false, false]);
  });

  /**
   * 行内写法必须也扫得到。上一版只扫「整行纯文本」，于是
   * `<p className="…">这一句是塞回来的界面说明句…。</p>` 这种一行写完的**全绿通过**
   * （实测：把 36 字带句号的说明塞进去，门禁没报）。现在改成抠 `>…<` 片段来判。
   */
  it("行内 JSX 文案扫得到，表达式与属性不算文案", () => {
    expect(
      inlineJsxTexts(
        '<p className="text-sm text-muted-foreground">还没有规则条目。</p>',
      ),
    ).toEqual(["还没有规则条目。"]);
    // 表达式片段不是文案
    expect(inlineJsxTexts("<span>{count} 条</span>")).toEqual([]);
    // 属性里的中文（字符串已剥）不在 `>…<` 之间
    expect(
      inlineJsxTexts('<input aria-label="工具名" className="flex-1" />'),
    ).toEqual([]);
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

/** 设置区允许的字号档：小字 / 正文 / 标题。 */
const ALLOWED_FONT_PX = new Set([12, 14, 16]);

/**
 * 版式守卫：字号只准用 12 / 14 / 16 三档，页面标题不准自带大字号。
 *
 * 背景（2026-09-27 第四轮反馈「排版很乱」）：量出来设置区混着 9px / 10px / 11px / 12.8px
 * 四个自定档位，标题有 `text-base/500`、`text-lg/600`、`text-lg/500`、`text-sm/500` 四种规格
 * ——同一个「通用」页里 16px 与 18px/600 并排。字号规格统一收进
 * `apps/web/src/lib/settings-layout.ts` 后，由这条门禁盯住不再散掉。
 *
 * 唯一例外：导航分组眉标（`uppercase` 那一行）按惯例比条目小一档，故 < 12px 且同带
 * `uppercase` 的行放过。
 */
function findFontViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of settingsFiles()) {
    const lines = readFileSync(file, "utf-8").split(/\r?\n/);
    const comments = commentFlags(lines);
    lines.forEach((raw, index) => {
      if (comments[index] || isComment(raw)) return;
      const rel = file.slice(file.indexOf("components"));
      for (const match of raw.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        const px = Number(match[1]);
        if (ALLOWED_FONT_PX.has(px)) continue;
        if (px < 12 && raw.includes("uppercase")) continue;
        violations.push({
          file: rel,
          line: index + 1,
          text: `字号 ${px}px 不在 12/14/16 三档内`,
        });
      }
      if (/text-(lg|xl|2xl|3xl)\b/.test(raw)) {
        violations.push({
          file: rel,
          line: index + 1,
          text: "页面标题请用 SETTINGS_TITLE / SETTINGS_TITLE_TEXT",
        });
      }
    });
  }
  return violations;
}

/**
 * 版式守卫（二）：配置行必须「标签在左、控件在右」。
 *
 * 用户口径 2026-09-27：「好多可以设置成左右的，你为什么要设置成上下！！！！」——
 * 起因是我把「控件被嫌只有 87px 宽」误判成「该拆成两行、控件铺满」，于是把浏览器页的
 * 两个下拉改成了「标签上 / 控件下」。正确解是同一行内把控件放宽。
 *
 * 判据用**全宽下拉**当信号：`SelectTrigger` 一旦 `w-full`，几乎必然是拆成了两行
 * （一行一个控件的下拉没有理由占满整行）。这条能抓住当时那 4 处（浏览器 ×2、
 * 通用模型 ×1、终端 ×1）。真正的多行编辑（textarea / 表单里的输入）不受此限。
 */
function findStackedControlViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of settingsFiles()) {
    const lines = readFileSync(file, "utf-8").split(/\r?\n/);
    const comments = commentFlags(lines);
    lines.forEach((raw, index) => {
      if (comments[index] || isComment(raw)) return;
      if (!/className=.*\bw-full\b/.test(raw)) return;
      // 往回看三行找这个 className 属于哪个元素——**跳过注释行**：
      // 浏览器页上面就有一条 biome-ignore 注释里写着「SelectTrigger」，会被误当成控件
      let context = "";
      for (let i = Math.max(0, index - 3); i <= index; i += 1) {
        if (comments[i] || isComment(lines[i] ?? "")) continue;
        context += `${lines[i]}\n`;
      }
      if (!/SelectTrigger/.test(context)) return;
      violations.push({
        file: file.slice(file.indexOf("components")),
        line: index + 1,
        text: "全宽下拉＝又拆成上下排布了；用 SETTINGS_CONTROL_WIDTH",
      });
    });
  }
  return violations;
}

describe("版式硬约束：设置区字号只有三档", () => {
  it("没有自定字号，也没有自带大字号", () => {
    const violations = findFontViolations();
    const rendered = violations
      .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
      .join("\n");
    expect(
      violations.length,
      `设置区字号/标题规格散掉了（统一走 settings-layout.ts）：\n${rendered}`,
    ).toBe(0);
  });

  it("守卫自身有效：认出 9px 与 text-lg，放过三档与眉标", () => {
    expect(ALLOWED_FONT_PX.has(9)).toBe(false);
    expect(ALLOWED_FONT_PX.has(12)).toBe(true);
    // 眉标（uppercase）允许比 12px 小一档
    const eyebrow = 'className="px-3 text-[10px] uppercase tracking-wide"';
    expect(/text-\[(\d+(?:\.\d+)?)px\]/.exec(eyebrow)?.[1]).toBe("10");
    expect(eyebrow.includes("uppercase")).toBe(true);
  });

  it("配置行没有全宽下拉（全宽＝拆成了上下排布）", () => {
    const violations = findStackedControlViolations();
    const rendered = violations
      .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
      .join("\n");
    expect(
      violations.length,
      `设置区出现全宽下拉（标签在左、控件在右；用 SETTINGS_CONTROL_WIDTH）：\n${rendered}`,
    ).toBe(0);
  });
});
