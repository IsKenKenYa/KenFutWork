/**
 * SAG2 知识库能力缝的 Service Definition（M1 骨架）。
 *
 * 契约属主：《改造计划》§4.2（新增 ctx key 只登记那一处）。
 * 本轮只落地「安装态门控 + 状态」；检索/目录/凭据编排在 M2 挂到同一接口上，
 * 消费方（M3 pre-step preflight、M4 侧边栏面板）不需要改签名。
 */

/** 市场 bundle 插件 id，与 `plugins/knowledge/package.json` 的 name 对齐。 */
export const KNOWLEDGE_BUNDLE_ID = "kenfutwork-knowledge";

/**
 * 证据对象。字段按上游 `protocol/src/cli.rs::SearchResult` 归一化：
 * **没有** offset / length / source_id / file_version —— 那些只存在于 core 内部
 * 的 `Candidate`，不进 CLI JSON。行范围用 startLine / endLine 表示。
 */
export interface KnowledgeEvidence {
  path: string;
  absolutePath: string;
  startLine: number;
  endLine: number;
  heading?: string;
  content?: string;
  matchedLines?: number[];
}

export type KnowledgeCliState =
  /** 本机已装可复用，或插件自带已落位。 */
  | "available"
  /** 未安装且下载不可用（离线首启等）。 */
  | "missing"
  /** 平台无原生二进制（macOS Intel / Linux）。 */
  | "unsupported_platform";

export interface KnowledgeStatus {
  /** 侧边栏 bundle 是否已安装。 */
  installed: boolean;
  /** 已安装且未停用。 */
  enabled: boolean;
  /** 安装态门控结论：三者全真才激活能力。 */
  active: boolean;
  cli: KnowledgeCliState;
  /** 钉死的上游 CLI 版本（M0 核验）。 */
  cliVersion: string;
  /** 未激活/异常时给面板看的明确原因；正常为 null。 */
  reason: string | null;
}

export interface KnowledgeGateVerdict {
  ok: boolean;
  /** 失败原因必须能直接显示给用户，不含凭据、不含堆栈。 */
  message: string;
}

/** TypeSafe Jev 凭据在 `modelProviders` 中的约定实例 id（M2 定，M4 可在设置里改）。 */
export const KNOWLEDGE_JEV_PROVIDER_ID = "typesafe-jev";

/**
 * 上游 `FileTypes::default()` 是 `code:false, config:false`（M0 §3），
 * 故新根必须用 `sag add --types` 显式列出文档 + 代码扩展名。
 * 已存在的根**不改**这个列表——`--types` 是「只索引这些」，会覆盖用户桌面端设置。
 * 列表逐项经 0.1.8 实机 `sag add --types <ext>` 探针核验（2026-11-09）：
 * csv/log/mts/cts/less/graphql/proto 会被 CLI 拒绝（「不支持的索引格式」），不得入列。
 */
export const KNOWLEDGE_INDEX_EXTENSIONS: readonly string[] = [
  "md",
  "markdown",
  "txt",
  "rst",
  "html",
  "htm",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "xml",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "rb",
  "php",
  "sh",
  "bash",
  "ps1",
  "sql",
  "vue",
  "svelte",
  "css",
  "scss",
];

export interface KnowledgeRoot {
  path: string;
  name: string;
  status: string;
  count: number;
  error: string | null;
}

export type KnowledgeCoverage = "included" | "partial" | "excluded" | "none";

export interface KnowledgeCheck {
  path: string;
  coverage: KnowledgeCoverage;
  indexReady: boolean;
  enabled: boolean;
  indexedFiles: number;
  extensions: string[];
  roots: KnowledgeRoot[];
  ready: boolean;
}

export interface KnowledgeAddRootInput {
  path: string;
  types?: readonly string[];
}

export interface KnowledgeRootMutation {
  path: string;
  indexStatus?: string;
  cliAuthorized?: boolean;
}

export interface KnowledgeEnsureResult {
  path: string;
  action: "already-indexed" | "added" | "rejected" | "deferred";
  reason?: string;
}

export interface KnowledgeSearchInput {
  query: string;
  path?: string;
  maxResults?: number;
}

export interface KnowledgeSearchResult {
  scope: string;
  results: KnowledgeEvidence[];
  truncated: boolean;
}

export interface KnowledgeReadInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface KnowledgeReadResult {
  path: string;
  content: string;
  truncated: boolean;
}

export interface KnowledgeInitResult {
  ok: boolean;
  /** reused = 尊重既有配置；injected = stdin 注入；missing = 无凭据且未擅自创建。 */
  credential: "reused" | "injected" | "missing";
  cli: KnowledgeCliState;
  reason: string | null;
}

export type KnowledgeErrorCode =
  | "invalid_input"
  | "service_unavailable"
  | "application_error";

/** 统一错误：code 只能取契约里的封闭枚举，避免响应退化成 ZodError 转储。 */
export class KnowledgeServiceError extends Error {
  readonly code: KnowledgeErrorCode;
  constructor(code: KnowledgeErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeServiceError";
    this.code = code;
  }
}

/**
 * 能力缝。**安装态在调用时读、绝不缓存**：
 * `plugins.list()` 的结果随装卸变化，缓存会让「装/卸下一轮即生效」失效。
 */
export interface KnowledgeService {
  /** 运行期门控；注册表不可用时 fail closed。 */
  isActive(): Promise<KnowledgeGateVerdict>;
  /** 状态聚合，供 `/api/knowledge/status` 与侧边栏心跳消费。 */
  status(): Promise<KnowledgeStatus>;
  /** 幂等初始化：CLI 探测 + Jev 凭据注入（不含注册知识库根，见 `ensureRoot`）。 */
  initialize(): Promise<KnowledgeInitResult>;
  listRoots(): Promise<KnowledgeRoot[]>;
  addRoot(input: KnowledgeAddRootInput): Promise<KnowledgeRootMutation>;
  removeRoot(path: string): Promise<KnowledgeRootMutation>;
  /**
   * KB-3：按**调用方给出的真实工作目录**幂等确保索引。
   * M2 只提供能力；M3 的 pre-step 从 run 上下文解析目录后调用，
   * 因为服务端没有「不依赖 run 的全局当前工作区根」服务（M2 核验）。
   */
  ensureRoot(path: string): Promise<KnowledgeEnsureResult>;
  search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult>;
}
