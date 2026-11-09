/**
 * SAG CLI 输出契约（M0 核验产物，2026-11-08）。
 *
 * 字段名**不是猜的**：取自上游 `protocol/src/cli.rs` 与 `protocol/src/types.rs`
 * 的 serde 定义，以及 `cli/src/main.rs` 里 `serde_json::to_string(...)` 的实际调用点。
 * 关键 serde 细节：
 * - `IndexCoverage` / `ModelAuthMode` 带 `#[serde(rename_all = "snake_case")]`
 *   → `included|partial|excluded|none`、`bearer|none`。
 * - `heading` / `content` / `matched_lines` / `count` / `extensions` /
 *   `reasoning_effort` 都有 `skip_serializing_if`，故为可选。
 * - `Root.error: Option<String>` **没有** skip，正常会输出 `null`。
 * - `SearchOutput` / `MatchOutput` 顶层还有 `protocol_version` 与 `scope`。
 *
 * 宽容策略：zod 4 的 `z.object` 默认剥离未知键，上游加字段不会炸；
 * 只有缺必需字段才报错，且错误必须进状态接口显式上报，不静默吞掉。
 *
 * 注意：本机未安装 `sag` CLI，随附 fixture 是**按 serde 定义推导**的，不是实机采集。
 * `probe/collect.mjs` 在有 CLI 的机器上重采后可覆盖 fixture，漂移由本目录单测锁死。
 */

import { z } from "zod";
import type { KnowledgeEvidence } from "./types.js";

/** npm registry `@zleap-ai/sag/latest`，2026-11-08 核验。 */
export const SAG_CLI_VERSION = "0.1.8";
export const SAG_CLI_TARBALL =
  "https://registry.npmjs.org/@zleap-ai/sag/-/sag-0.1.8.tgz";
export const SAG_CLI_SHASUM = "22d9c5ae11d34f17042cce70971a3cda6c0ed454";
export const SAG_CLI_INTEGRITY =
  "sha512-VqKNCWvzy1gui3nUpcmFKpH7D2h1a+46hJ76O2xLFD1+FWIXfw0RaLGzxQfccr5nGUiAD4ntKcTB3ZRp0hf2YA==";

/**
 * npm 包声明 `os: [darwin, win32]` / `cpu: [arm64, x64]`，但 README 明确
 * 只带 macOS Apple Silicon 与 Windows x64 原生二进制。按**交叉组合**判定，
 * 不按 os/cpu 数组的笛卡尔积，避免 macOS Intel 被误判为可用。
 */
export function isSagCliPlatformSupported(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return (
    (platform === "win32" && arch === "x64") ||
    (platform === "darwin" && arch === "arm64")
  );
}

/** `cli/src/main.rs`：搜索内容为空或超过 2000 字符时 `exit(2)`。 */
export const SAG_QUERY_MAX_CHARS = 2000;
export const SAG_RESULT_LIMIT_MIN = 1;
export const SAG_RESULT_LIMIT_MAX = 100;

/** `cli/src/main.rs` 显式退出码；130 = Ctrl-C 中断。 */
export const SAG_EXIT = {
  ok: 0,
  degraded: 1,
  argument: 2,
  interrupted: 130,
} as const;

/** `check` 通过条件（main.rs）：coverage=included && index_ready && enabled && indexed_files>0。 */
export function isSagIndexReady(output: SagCheckOutput): boolean {
  return (
    output.coverage === "included" &&
    output.index_ready &&
    output.enabled &&
    output.indexed_files > 0
  );
}

/** `ModelConfig::is_configured()`：用于「已配置则复用、绝不覆盖」。 */
export function isSagConfigured(config: SagModelConfig): boolean {
  return (
    config.model.trim().length > 0 &&
    (config.auth_mode === "none" || config.has_key)
  );
}

/** `protocol/src/types.rs::Root`。 */
export const sagRootSchema = z.object({
  path: z.string(),
  name: z.string(),
  status: z.string(),
  count: z.number().int().nonnegative(),
  // Option<String> 无 skip → 正常输出 null；上游若省略也接受，避免版本抖动炸解析。
  error: z.string().nullable().optional(),
});

/** `#[serde(rename_all = "snake_case")] enum IndexCoverage`。 */
export const sagIndexCoverageSchema = z.enum([
  "included",
  "partial",
  "excluded",
  "none",
]);

/** `protocol/src/cli.rs::CheckOutput`（`sag check --json` 顶层）。 */
export const sagCheckOutputSchema = z.object({
  extensions: z.array(z.string()).optional(),
  path: z.string(),
  coverage: sagIndexCoverageSchema,
  index_ready: z.boolean(),
  enabled: z.boolean(),
  indexed_files: z.number().int().nonnegative(),
  roots: z.array(sagRootSchema),
});

/** `AddOutput`（`sag add --json`）。 */
export const sagAddOutputSchema = z.object({
  path: z.string(),
  index_status: z.string(),
  cli_authorized: z.boolean(),
});

/** `Response::Removed { path }`，main.rs 里唯一 `json!` 精确键。 */
export const sagRemoveOutputSchema = z.object({ path: z.string() });

/** `Response::Roots(Vec<Root>)`（`sag list --json` 顶层是数组，无包装对象）。 */
export const sagListOutputSchema = z.array(sagRootSchema);

/** `protocol/src/cli.rs::SearchResult`。 */
export const sagSearchResultSchema = z.object({
  heading: z.string().optional(),
  path: z.string(),
  absolute_path: z.string(),
  start_line: z.number().int().nonnegative(),
  end_line: z.number().int().nonnegative(),
  content: z.string().optional(),
  matched_lines: z.array(z.number().int().nonnegative()).optional(),
});

/** `SearchOutput`（`sag "<query>" --json`）。 */
export const sagSearchOutputSchema = z.object({
  protocol_version: z.number().int().nonnegative(),
  scope: z.string(),
  results: z.array(sagSearchResultSchema),
  truncated: z.boolean(),
});

/** `MatchFile`（-E / -F 行匹配）。 */
export const sagMatchFileSchema = z.object({
  path: z.string(),
  absolute_path: z.string(),
  count: z.number().int().nonnegative().optional(),
});

/** `MatchOutput`（`sag -E/-F --json`）。 */
export const sagMatchOutputSchema = z.object({
  protocol_version: z.number().int().nonnegative(),
  scope: z.string(),
  results: z.array(sagSearchResultSchema),
  files: z.array(sagMatchFileSchema),
  matched: z.boolean(),
  truncated: z.boolean(),
});

/** `#[serde(rename_all = "snake_case")] enum ModelAuthMode`。 */
export const sagModelAuthModeSchema = z.enum(["bearer", "none"]);

/** `protocol/src/types.rs::ModelConfig`（`sag config` 总是输出 pretty JSON）。 */
export const sagModelConfigSchema = z.object({
  url: z.string(),
  model: z.string(),
  models: z.array(z.string()),
  has_key: z.boolean(),
  /**
   * 0.1.8 实机 `sag config` 输出**缺省此字段**（与 main 分支 types.rs 的
   * `ModelConfig` 声明不一致，发布版疑似旧结构）。设为可选以避免真机解析失败；
   * `isSagConfigured()` 在缺省时按 has_key 判定，语义不变。
   */
  auth_mode: sagModelAuthModeSchema.optional(),
  reasoning_effort: z.enum(["none", "low", "medium", "high", "max"]).optional(),
});

/** `Status` 是内部类型：`sag status` **不输出 JSON**（main.rs 用 println 文本）。 */
export const sagStatusSchema = z.object({
  protocol_version: z.number().int().nonnegative(),
  connected: z.boolean(),
  enabled: z.boolean(),
  jev_configured: z.boolean(),
});

export type SagRoot = z.infer<typeof sagRootSchema>;
export type SagIndexCoverage = z.infer<typeof sagIndexCoverageSchema>;
export type SagCheckOutput = z.infer<typeof sagCheckOutputSchema>;
export type SagAddOutput = z.infer<typeof sagAddOutputSchema>;
export type SagRemoveOutput = z.infer<typeof sagRemoveOutputSchema>;
export type SagSearchResult = z.infer<typeof sagSearchResultSchema>;
export type SagSearchOutput = z.infer<typeof sagSearchOutputSchema>;
export type SagMatchOutput = z.infer<typeof sagMatchOutputSchema>;
export type SagModelConfig = z.infer<typeof sagModelConfigSchema>;

/** 上游 snake_case → 宿主证据对象（camelCase），不泄漏协议字段。 */
export function toKnowledgeEvidence(item: SagSearchResult): KnowledgeEvidence {
  return {
    path: item.path,
    absolutePath: item.absolute_path,
    startLine: item.start_line,
    endLine: item.end_line,
    ...(item.heading ? { heading: item.heading } : {}),
    ...(item.content === undefined ? {} : { content: item.content }),
    ...(item.matched_lines?.length ? { matchedLines: item.matched_lines } : {}),
  };
}
