import hljs from "highlight.js/lib/common";

/**
 * 文件预览的语法高亮（用户口径：「文件目录应该可以支持预览+高亮！！！应该考虑点击文件名可以
 * 打开预览文件」）。
 *
 * 用 `highlight.js/lib/common`（常用语言那一包，别把全部 190+ 语言打进前端）。
 * 两条边界如实说明：
 * - **只认扩展名**：判不出来就按纯文本显示，不猜、也不硬塞一个语言进去；
 * - 返回的是**已转义**的 HTML（highlight.js 自己会转义 `<`/`&`），界面用 `dangerouslySetInnerHTML`
 *   渲染是安全的——这一点由单测锁住（喂一段含 `<script>` 的内容，断言输出里是 `&lt;`）。
 */

/** 扩展名 → highlight.js 语言名。只列常用的；未列出的返回 null（纯文本显示）。 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "xml",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  lua: "lua",
  md: "markdown",
  mjs: "javascript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  bash: "bash",
  sql: "sql",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  vue: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

/** 文件名 → 语言（`Dockerfile` / `Makefile` 这类没有扩展名的单独认）。 */
export function languageForPath(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  if (lower === ".env" || lower.startsWith(".env.")) return "ini";
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;
  return LANGUAGE_BY_EXTENSION[lower.slice(dot + 1)] ?? null;
}

/**
 * 高亮成 HTML；判不出语言或高亮失败都返回 null（调用方回落到纯文本，绝不半渲染）。
 */
export function highlightCode(text: string, path: string): string | null {
  const language = languageForPath(path);
  if (!language) return null;
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
