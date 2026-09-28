import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 界面文案与版式硬约束守卫（《AGENTS.md》「界面文案（硬约束）」，用户口径 2026-09-27）。
 *
 * 背景：语音设置页曾把方案文档整段抄进界面（「松开后把文字填进输入框，你自己确认再发送」、
 * 「预估：本机 CPU 实时率约 0.1–0.7（首次调用含模型载入会更慢）」），用户原话
 * 「根本不是给人看的」「我给你描述的是需求，而不是让你原原本本写上去」。之后每一轮又各抓到
 * 一类同族问题：复述标签的副标题（「后台运行，不弹窗口（下次连接生效）」）、把要求原样抄上界
 * （要求「做个假的弹窗」→ 界面写「假的弹窗」「虚假提交」）、能左右却在上下排布。用户后续原话：
 * 「还是很啰嗦」「好多可以设置成左右的，你为什么要设置成上下」「添加硬约束，所有内容的文本
 * 不要啰哩巴嗦」。三类问题都由本门禁盯住，不再靠人盯：
 *
 * ① **文案（全站）**：`src/components` 与 `src/app` 下所有 tsx 的 JSX 文本出现句子标点
 *    （。；，）、中文字数超过 20、或占位/虚假词（假的 / 虚假 / 即将上线 / 占位；「占位符」
 *    是正常术语，除外）→ 违约；**文案属性**（`hint` / `title` / `placeholder` / `emptyLabel` /
 *    `description`）的值同样受这两条约束，字符串写法与三元写法都扫（模板字符串是动态数据，不判）；
 * ② **版式（设置区）**：出现「第二行小字」副标题（`block text-xs`）、全宽下拉、或带 `mt-` 的
 *    全宽单行输入（= 标签上/控件下的上下排布）→ 违约；
 * ③ **残留（设置区）**：删文案剩下的空元素；字号只准 12 / 14 / 16 三档，标题走统一常量。
 *
 * 判定刻意收窄以免误伤：
 * - 注释整行/整段/行尾都跳过（说明留在代码里是对的）；
 * - 先把字符串字面量剥掉——**报错信息是硬约束的例外**（`message: "保存失败。"` 合法）；
 * - 再剥 `{…}` 表达式与 JSX 标签，剩下的才是用户看得见的文本；
 * - 只认含中文、且不含代码形状的文本；行数按**中文字数**算（Node / npx / JSON 这类
 *   技术词不算「啰嗦」）。
 */

const COMPONENTS = join(import.meta.dirname, "..", "src", "components");
const APP = join(import.meta.dirname, "..", "src", "app");
const CJK = /[\u4e00-\u9fff]/;
const CJK_GLOBAL = /[\u4e00-\u9fff]/g;

/** 设置区文件清单（设置弹窗 + 各 section + 供应商表单；版式规则只对它们生效）。 */
function settingsFiles(): string[] {
  const files: string[] = [];
  for (const dir of [COMPONENTS, join(COMPONENTS, "workbench")]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".tsx")) continue;
      if (!/(section|settings|provider-instance-form)\.tsx$/.test(entry.name)) {
        continue;
      }
      files.push(join(dir, entry.name));
    }
  }
  return files.sort();
}

/** 全站界面文件（文案规则扫这里：组件 + 页面）。 */
function uiFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".tsx")) files.push(path);
    }
  };
  walk(COMPONENTS);
  walk(APP);
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
 * 这一行里用户看得见的文本：剥掉字符串 → 剥掉行内块注释 → 砍掉行尾 `//` 注释 →
 * 剥掉 `{…}` 表达式 → 剥掉 JSX 标签 → 压空白。
 *
 * 上一版的两种写法各有一个盲区（实测都漏过文案）：
 * ① 只看「整行没有 `<` `>` `=`」的纯文本行 → `<p className="…">说明句。</p>` 这种
 *    一行写完的直接全绿；
 * ② 抠 `>…<` 片段 → `<p>一行一条，支持 <code>*</code> 支持通配；拒绝优先</p>` 里被标签
 *    夹断的后半句漏判（逗号/分号句就是这样塞回来的）。
 * 现在改成「先剥、再看剩下什么」，两种都逃不掉；行尾注释（`? // 说明`）也不再算文案。
 */
function jsxTextChunk(line: string): string {
  let text = stripStringLiterals(line).replace(/\/\*[\s\S]*?\*\//g, " ");
  const trailing = text.indexOf("//");
  if (trailing >= 0) text = text.slice(0, trailing);
  return text
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 剥完之后还剩下的是不是「用户看得见的文本」：含中文，且不含代码形状
 * （`()` `[]` `{}` `=` `;` `|` —— 正则字面量、数组解构、比较表达式这类代码行都会带它们）。
 */
function isUiText(chunk: string): boolean {
  if (chunk.length === 0 || !CJK.test(chunk)) return false;
  return !/[()[\]{}=;|]/.test(chunk);
}

/** 中文字数（技术词不算啰嗦：Node / npx / JSON / token 都不计）。 */
export function cjkCount(text: string): number {
  return (text.match(CJK_GLOBAL) ?? []).length;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * 占位/虚假词：用户口径里的「假的弹窗」「虚假提交」这类**把要求抄上界面**的写法，
 * 与「即将上线」「占位」同罪。「占位符」是正常术语（`{{sessionId}}` 占位符），不算。
 */
const BANNED_WORDS = /假的|虚假|即将上线|占位(?!符)/;

/**
 * 界面文案属性（`hint` / `title` / `placeholder` / `emptyLabel`）：这些 prop 的值**必然是**用户
 * 看得见的文案，同样受「不写句子、不超 20 个中文字」约束。
 *
 * 为什么单列一条：JSX 文本之外的文案藏在字符串里，主规则（先剥字符串）看不见它们——
 * 实测从空态提示、悬停提示与输入框提示里又抓出十几处句子级文案（「去「推荐」一键添加，
 * 或在下方手动添加。」）。报错信息的例外不受影响：报错走 `message` / `throw`，不叫这些 prop 名。
 */
const COPY_PROPS =
  /\b(hint|title|placeholder|emptyLabel|description)="([^"]*)"/g;

/** 表达式写法（`prop={cond ? "a" : "b"}`）：该行里属于这个 prop 的字符串字面量同样要判。 */
const COPY_PROP_EXPR = /\b(hint|title|placeholder|emptyLabel|description)=\{/;
const STRING_LITERAL = /["']([^"']*)["']/g;

/**
 * 一行里所有「用户看得见的文案属性值」：字符串写法（`prop="…"`）与表达式写法
 * （`prop={cond ? "a" : "b"}`，取该行字面量）都算。模板字符串是动态拼数据，不判。
 */
function copyPropValues(line: string): string[] {
  const values: string[] = [];
  for (const match of line.matchAll(COPY_PROPS)) values.push(match[2] ?? "");
  if (COPY_PROP_EXPR.test(line)) {
    for (const literal of line.matchAll(STRING_LITERAL)) {
      values.push(literal[1] ?? "");
    }
  }
  return values;
}

/** 全站文案规则：句子标点（。；，）、中文字数 > 20、占位/虚假词、或文案属性里的句子。 */
function findCopyViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of uiFiles()) {
    const lines = readFileSync(file, "utf-8").split(/\r?\n/);
    const comments = commentFlags(lines);
    lines.forEach((raw, index) => {
      if (comments[index] || isComment(raw)) return;
      const rel = file.slice(file.indexOf("src"));
      const at = { file: rel, line: index + 1 };
      // 文案属性（字符串值，主规则剥字符串后看不见）：必须看**原始行**，
      // 剥过字符串的版本里值已经变成空串。字符串与表达式两种写法都由 copyPropValues 收齐。
      for (const value of copyPropValues(raw)) {
        if (!CJK.test(value)) continue;
        if (/[。；，]/.test(value) || cjkCount(value) > 20) {
          violations.push({
            ...at,
            text: `属性文案：${value.slice(0, 60)}`,
          });
        }
      }
      const text = jsxTextChunk(raw);
      if (!isUiText(text)) return;
      if (BANNED_WORDS.test(text)) {
        violations.push({ ...at, text: `占位/虚假词：${text.slice(0, 60)}` });
        return;
      }
      if (/[。；，]/.test(text)) {
        violations.push({ ...at, text: `句子标点：${text.slice(0, 60)}` });
        return;
      }
      if (cjkCount(text) > 20) {
        violations.push({
          ...at,
          text: `${cjkCount(text)} 个中文字：${text.slice(0, 60)}`,
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

describe("界面文案硬约束（全站）：只写标签，不写句子", () => {
  it("没有句子标点、没有超过 20 个中文字的整句、没有占位/虚假词", () => {
    const violations = findCopyViolations();
    const rendered = violations
      .map((v) => `  ${v.file}:${v.line}  「${v.text}」`)
      .join("\n");
    expect(
      violations.length,
      `界面出现说明句/占位词（只写标签；说明放 docs 或代码注释）：\n${rendered}`,
    ).toBe(0);
  });

  it("守卫自身有效：认出塞回来的说明句，放过报错文案与代码行", () => {
    expect(
      isUiText(
        jsxTextChunk("        松开后把文字填进输入框，你自己确认再发送。"),
      ),
    ).toBe(true);
    // 报错文案在字符串里：剥掉字符串后没有中文可判（硬约束的例外）
    expect(isUiText(jsxTextChunk('        message: "保存失败。",'))).toBe(
      false,
    );
    // 代码行（正则字面量 / 解构 / 比较）不会被误判成界面文案
    expect(
      isUiText(
        jsxTextChunk(
          "    const match = report.speak.summary.match(/首包 ([\\d.]+)s、实时率/);",
        ),
      ),
    ).toBe(false);
    expect(
      isUiText(jsxTextChunk('        const [value, setValue] = useState("");')),
    ).toBe(false);
    // 行尾注释不算文案（`? // 说明` 这种曾在全站扫描里误报过）
    expect(jsxTextChunk("      ? // 已绑定真实目录：可以说出工作区根")).toBe(
      "?",
    );
    // 中文字数按中文算：技术词再长也不算啰嗦
    expect(cjkCount("离线可用 · 需本机装 Node（npx）或 Python（uv/uvx）")).toBe(
      9,
    );
  });

  /** 文案属性两种写法都要收：字符串写法与三元写法（漏掉后者时会话里又出现句子级提示）。 */
  it("文案属性扫得到两种写法，模板字符串不判", () => {
    expect(
      copyPropValues('        hint="去「推荐」一键添加，或在下方手动添加。"'),
    ).toEqual(["去「推荐」一键添加，或在下方手动添加。"]);
    expect(
      copyPropValues(
        '        title={staged ? "取消暂存（文件内容不动）" : "下次提交带上"}',
      ),
    ).toEqual(["取消暂存（文件内容不动）", "下次提交带上"]);
    // 模板字符串是动态拼数据（读数/轮次），不当文案判
    expect(copyPropValues("        title={`第 1 轮`}")).toEqual([]);
  });

  /**
   * 标签夹断的长句必须也扫得到。上一版抠 `>…<` 片段的写法漏过这一种：
   * `<p>一行一条，支持 <code>*</code> 支持通配；拒绝优先</p>` 里 `；` 之后那半句没有
   * 闭合的 `<`，整句在全绿里塞了回去（实测）。
   */
  it("标签夹断的句子扫得到，表达式与纯结构行不算文案", () => {
    expect(
      jsxTextChunk(
        '<p className="text-xs">一行一条，支持 <code>*</code> 支持通配；拒绝优先</p>',
      ),
    ).toBe("一行一条，支持 * 支持通配；拒绝优先");
    // 表达式片段剥掉后只剩结构
    expect(jsxTextChunk("<span>{count} 条</span>")).toBe("条");
    // 属性里的中文（字符串已剥）不算文本
    expect(
      jsxTextChunk('<input aria-label="工具名" className="flex-1" />'),
    ).toBe("");
  });

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
 * 版式守卫（二）：一行一个配置项——标签在左、控件在右。
 *
 * 用户口径 2026-09-27：「好多可以设置成左右的，你为什么要设置成上下！！！！」
 * 起因是我把「控件被嫌只有 87px 宽」误判成「该拆成两行、控件铺满」，于是把浏览器页的
 * 两个下拉改成了「标签上 / 控件下」。正确解是同一行内把控件放宽。
 *
 * 三种上下排布的机械信号：
 * ① `SelectTrigger` 带 `w-full`（一行一个控件的下拉没有理由占满整行）；
 * ② 单行 `input` 带 `mt-` + `w-full`（标签压在上面、控件铺满）；
 * ③ 行内第二行小字 `block text-xs`（复述标签的副标题——用户口径「副标题默认不写」）。
 * 真正的多行编辑（textarea / JSON 编辑器）不受此限。
 */
function findStackedControlViolations(): Violation[] {
  const violations: Violation[] = [];
  // ② 单行输入「标签上 / 控件下」是全站口径（模型编辑弹窗也踩过同一坑）；
  // ①③ 两条留在设置区：别处（如对话框表单里的栅格）全宽下拉与行内小字有正当用法。
  const settings = new Set(settingsFiles());
  for (const file of uiFiles()) {
    const inSettings = settings.has(file);
    const lines = readFileSync(file, "utf-8").split(/\r?\n/);
    const comments = commentFlags(lines);
    lines.forEach((raw, index) => {
      if (comments[index] || isComment(raw)) return;
      const rel = file.slice(file.indexOf("components"));
      // ③ 第二行小字（复述标签的副标题）
      if (inSettings && /\bblock text-xs\b/.test(stripStringLiterals(raw))) {
        violations.push({
          file: rel,
          line: index + 1,
          text: "行内副标题（复述标签）：标签与值同行，说明不写",
        });
        return;
      }
      if (!/className=.*\bw-full\b/.test(raw)) return;
      // 往回看六行找这个 className 属于哪个元素——**跳过注释行**：
      // 浏览器页上面就有一条 biome-ignore 注释里写着「SelectTrigger」，会被误当成控件
      let context = "";
      for (let i = Math.max(0, index - 6); i <= index; i += 1) {
        if (comments[i] || isComment(lines[i] ?? "")) continue;
        context += `${lines[i]}\n`;
      }
      if (inSettings && /SelectTrigger/.test(context)) {
        violations.push({
          file: rel,
          line: index + 1,
          text: "全宽下拉＝又拆成上下排布了；用 SETTINGS_CONTROL_WIDTH",
        });
        return;
      }
      if (/<input\b|<Input\b/.test(context) && /\bmt-\d/.test(raw)) {
        violations.push({
          file: rel,
          line: index + 1,
          text: "单行输入拆成了上下两行；标签在左、控件在右",
        });
      }
    });
  }
  return violations;
}

describe("版式硬约束（设置区）", () => {
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

  it("配置行没有上下排布（全宽下拉 / mt- 全宽输入 / 行内副标题）", () => {
    const violations = findStackedControlViolations();
    const rendered = violations
      .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
      .join("\n");
    expect(
      violations.length,
      `设置区出现上下排布（标签在左、控件在右；用 SETTINGS_CONTROL_WIDTH）：\n${rendered}`,
    ).toBe(0);
  });

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
});
