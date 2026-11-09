/**
 * M2 的 KnowledgeService Provider：真实调用 `sag` CLI。
 *
 * - 安装态门控在**每次调用**时读（装／卸下一轮即生效）。
 * - 凭据初始化**懒执行且失败不缓存**：首次需要语义检索时才注入，失败如实上报。
 * - 纯本地命令（list/check/add/remove）不要求 Jev 凭据——知识库建库与
 *   「检索服务没配好」是两件事，不该互相阻断（KB-4：报错但不阻断）。
 * - 上游 stdout 一律经 zod 契约解析；字段漂移显式报错，不静默吞掉。
 */

import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { resolveGovernanceNumber } from "@kenfutwork/shared";
import {
  ensureKnowledgeRoot,
  initializeKnowledge,
  type KnowledgeInitOptions,
  normalizeKnowledgeRootPath,
  parseJsonOutput,
} from "../init.js";
import { createKnowledgeLibrary } from "../library.js";
import {
  isSagCliPlatformSupported,
  SAG_CLI_VERSION,
  SAG_EXIT,
  SAG_QUERY_MAX_CHARS,
  sagAddOutputSchema,
  sagListOutputSchema,
  sagMatchOutputSchema,
  sagRemoveOutputSchema,
  sagSearchOutputSchema,
  toKnowledgeEvidence,
} from "../sag-cli-contract.js";
import {
  SAG_EXIT_TIMEOUT,
  type SagCommandResult,
  type SagRunner,
} from "../sag-cli-runner.js";
import {
  createBundleInspector,
  type PluginsServiceLike,
  toGateVerdict,
} from "../service.js";
import {
  dedupeKnowledgeEvidence,
  KNOWLEDGE_INDEX_EXTENSIONS,
  type KnowledgeAddRootInput,
  type KnowledgeEnsureResult,
  type KnowledgeEvidence,
  type KnowledgeInitResult,
  type KnowledgeReadInput,
  type KnowledgeReadResult,
  type KnowledgeRoot,
  type KnowledgeRootMutation,
  type KnowledgeSearchInput,
  type KnowledgeSearchResult,
  type KnowledgeService,
  KnowledgeServiceError,
  type KnowledgeStatus,
} from "../types.js";

export interface SagCliProviderOptions {
  runner: SagRunner;
  /** 延迟取插件注册表，避免注册期依赖装配顺序。 */
  tryGetPlugins: () => PluginsServiceLike | undefined;
  /** 后台路径：`modelProviders.resolveCredentialsById(id).apiKey`。 */
  readJevCredential: () => Promise<string | null>;
  platform?: NodeJS.Platform;
  arch?: string;
  indexExtensions?: readonly string[];
  defaultMaxResults?: number;
  /**
   * 0 配置降级：语义档因缺 Jev 凭据不可用时，自动改用 `-F` 本地匹配并标记
   * `degraded:"local-match"`。默认开；关掉则语义失败直接抛错（KB-4 严格版）。
   */
  autoLocalFallback?: boolean;
  /**
   * KB-5 三级探测：系统 CLI → 自带 CLI → 按需下载。返回 missing/unsupported 时
   * 调用方 fail loud；成功时安装器已把二进制路径交给 runner（getter）。
   */
  ensureCli?: () => Promise<
    | { kind: "system" | "managed"; binary: string }
    | { kind: "missing"; reason: string; guidance: string }
    | { kind: "unsupported_platform"; reason: string }
  >;
  /** 应用数据根：托管目录落 `<dataDir>/knowledge/library`，缺省用进程 cwd。 */
  dataDir?: string;
  /** 只读 CLI 探测（不触发下载），供状态接口展示。 */
  cliStatus?: () => Promise<{
    state: "available" | "missing" | "unsupported_platform";
    reason: string | null;
  }>;
}

/** 把上游语义检索失败压成一句人话（面板/状态条用），不丢关键归因。 */
export function describeSemanticFailure(message: string): string {
  if (/401|Invalid API Key|无效的API/iu.test(message))
    return "语义检索凭据无效，请在 jev 插件或供应商设置里检查 TypeSafe Key";
  if (/JEV|Jev|jev/iu.test(message)) return "Jev 检索服务未就绪";
  if (/timeout|超时/iu.test(message)) return "语义检索超时";
  return `语义检索不可用（${(message.split("\n")[0] ?? "").slice(0, 80) || "未知原因"}）`;
}

/** CLI 缺失/下载失败的重试冷却：离线时避免每轮对话都卡在下载超时上。 */
const CLI_RETRY_COOLDOWN_MS = 300_000;

/**
 * 本地匹配档的关键词提取（纯规则、不调模型）：`-E` 是正则匹配，直接用整句
 * 「林远是谁」必然不命中——文档里只有「林远」。这里剔掉疑问/虚词，按空白与
 * 常见标点切分，保留有检索价值的片段，再用 `|` 组成正则。
 */
const LOCAL_MATCH_STOPWORDS = new Set([
  "是谁",
  "什么",
  "哪些",
  "哪个",
  "哪里",
  "怎么",
  "如何",
  "为什么",
  "是否",
  "有没有",
  "多少",
  "请问",
  "帮我",
  "告诉",
  "一下",
  "介绍",
  "说说",
  "相关",
  "关于",
  "以及",
  "还有",
  "其中",
  "的",
  "了",
  "吗",
  "呢",
  "吧",
  "啊",
  "呀",
  "是",
  "在",
  "有",
  "和",
  "与",
  "或",
  "及",
  "对",
  "把",
  "被",
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "what",
  "who",
  "which",
  "how",
  "why",
  "where",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "do",
  "does",
  "did",
  "please",
  "tell",
  "me",
]);

export function extractLocalMatchTerms(query: string): string[] {
  let normalized = query
    .replace(/[，。！？、；：,.!?;:()[\]{}"'“”‘’]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return [];
  // 中文没有空格：先按疑问/虚词把整句切开，再在片段里做尾部裁剪。
  // 单字虚词（的/了/吗…）同样参与切分——否则「负责人的联系方式」永远切不开。
  const splittable = [...LOCAL_MATCH_STOPWORDS]
    .filter((word) => /^[\u4e00-\u9fff]+$/u.test(word))
    .sort((a, b) => b.length - a.length);
  for (const word of splittable) {
    normalized = normalized.split(word).join(" ");
  }
  const terms = normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .filter((token) => !LOCAL_MATCH_STOPWORDS.has(token.toLowerCase()));
  // 尾部残留的单个虚词（的/了/吗…）也去掉
  const trimmed = terms.flatMap((token) => {
    const stripped = token
      .replace(/(是谁|是什么|有什么|在哪里|怎么样|为什么)+$/u, "")
      .replace(/[的了吗呢吧啊呀]+$/u, "");
    const candidates =
      stripped && stripped !== token ? [stripped, token] : [token];
    return candidates.filter((item) => item.length >= 2 || /[\d]/u.test(item));
  });
  return [...new Set(trimmed)].slice(0, 8);
}

/** 由关键词拼 `-E` 正则；无关键词时回退整句（尽量不退化成「永不命中」）。 */
export function buildLocalMatchPattern(query: string): string {
  const terms = extractLocalMatchTerms(query);
  // 无关键词（纯虚词/空）时回退整句，但**必须转义**——原句当正则会因 `.*`、`(` 等
  // 意外匹配一切或直接报错，宁可零命中也不能给出假证据。
  const source = terms.length === 0 ? [query.trim()] : terms;
  return source
    .filter((term) => term.length > 0)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
}

function decode<T>(
  result: SagCommandResult,
  label: string,
  schema: { parse: (value: unknown) => T },
): T {
  try {
    return schema.parse(parseJsonOutput(result, label));
  } catch (error) {
    if (error instanceof KnowledgeServiceError) throw error;
    throw new KnowledgeServiceError(
      "service_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function assertOk(result: SagCommandResult, label: string): void {
  if (result.code === SAG_EXIT.ok) return;
  throw new KnowledgeServiceError(
    "service_unavailable",
    `${label} 失败（退出码 ${result.code}）：${result.stderr.trim() || "无输出"}`,
  );
}

export function createSagCliProvider(
  options: SagCliProviderOptions,
): KnowledgeService {
  const inspect = createBundleInspector(options.tryGetPlugins);
  const supported = isSagCliPlatformSupported(options.platform, options.arch);
  // 「云盘式」托管目录：用户只传文件，目录自身作为唯一根注册。
  const library = createKnowledgeLibrary({
    dataDir: options.dataDir ?? process.cwd(),
    maxBytes: resolveGovernanceNumber("knowledgeReadMaxBytes", undefined),
  });
  const initOptions: KnowledgeInitOptions = {
    runner: options.runner,
    // check 短预算：冷启动超时就当未知覆盖，直接 add 拉起 service。
    checkTimeoutMs: resolveGovernanceNumber(
      "knowledgeCheckTimeoutMs",
      undefined,
    ),
    // add 首次建库要拉起 service 并索引，给足预算（与 list 冷启动同档）。
    addTimeoutMs: resolveGovernanceNumber("knowledgeAddTimeoutMs", undefined),
    readJevCredential: options.readJevCredential,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.arch ? { arch: options.arch } : {}),
    ...(options.indexExtensions
      ? { indexExtensions: options.indexExtensions }
      : {}),
  };

  /** 成功的初始化结果可缓存；失败不缓存，允许凭据配好后下一次调用自愈。 */
  let initResult: KnowledgeInitResult | undefined;
  /** 根集合修订号（KB-7 缓存键）：本插件驱动的根变更单调递增。 */
  let rootsRevision = 0;
  /**
   * 用户显式移除的根（墓碑）：preflight 的自动 ensureRoot 不得重加（§8.1）；
   * 侧边栏显式 addRoot 清除墓碑。只存规范化路径，不含文件元数据。
   */
  const userRemovedRoots = new Set<string>();

  /** CLI 三级探测结果：成功永久复用；失败冷却期内直接拒绝，不反复触发下载。 */
  let cliVerdict:
    | {
        at: number;
        result:
          | { kind: "system" | "managed"; binary: string }
          | { kind: "missing"; reason: string; guidance: string }
          | { kind: "unsupported_platform"; reason: string };
      }
    | undefined;

  async function ensureCliReady(): Promise<
    { kind: "system" | "managed"; binary: string } | undefined
  > {
    if (!options.ensureCli) return undefined;
    const now = Date.now();
    if (cliVerdict && cliVerdict.result.kind !== "missing") {
      return cliVerdict.result.kind === "unsupported_platform"
        ? undefined
        : cliVerdict.result;
    }
    if (
      cliVerdict &&
      cliVerdict.result.kind === "missing" &&
      now - cliVerdict.at < CLI_RETRY_COOLDOWN_MS
    ) {
      throw new KnowledgeServiceError(
        "service_unavailable",
        `${cliVerdict.result.reason} ${cliVerdict.result.guidance}`,
      );
    }
    const result = await options.ensureCli();
    cliVerdict = { at: now, result };
    if (result.kind === "unsupported_platform") {
      throw new KnowledgeServiceError("service_unavailable", result.reason);
    }
    if (result.kind === "missing") {
      throw new KnowledgeServiceError(
        "service_unavailable",
        `${result.reason} ${result.guidance}`,
      );
    }
    return result;
  }

  /** 成功初始化后置 true；缺凭据时记住，避免每轮都先等一次语义超时。 */
  let credentialMissing = false;
  /** 产出现在 initResult 时的二进制：二进制变了（系统/自带/下载切换）就要重试。 */
  let initBinary: string | undefined;
  /** 最近一次语义档失败的原因（凭据失效等）；状态接口如实透出，不假装就绪。 */
  let semanticFailureReason: string | undefined;

  /**
   * 便宜地判断「检索凭据是否就绪」：只跑 `sag config`（读既有配置，不发起检索），
   * 或在未配置时读宿主凭据源。目的只是避免首轮白等一次语义超时，失败一律不算错。
   */
  async function probeCredentialAvailability(): Promise<void> {
    if (initResult?.ok) return;
    if (initResult && !initResult.ok) {
      credentialMissing = true;
      return;
    }
    // 先过安装态/平台门：未安装时绝不能碰 CLI（M2 回归用例锁死过）。
    const inspection = await inspect();
    if (!inspection.ok || !supported) return;
    // 先解析 CLI 二进制（系统/自带/下载），否则 init 会 spawn 到不存在的 "sag"。
    const cli = await ensureCliReady();
    initResult = await initializeKnowledge(initOptions);
    initBinary = cli?.binary;
    credentialMissing = !initResult.ok;
  }

  async function assertReady(requireCredential: boolean): Promise<void> {
    const inspection = await inspect();
    if (!inspection.ok) {
      throw new KnowledgeServiceError(
        "service_unavailable",
        inspection.message,
      );
    }
    if (!supported) {
      throw new KnowledgeServiceError(
        "service_unavailable",
        "当前平台没有 SAG CLI 原生二进制（仅 Windows x64 与 macOS Apple Silicon）。",
      );
    }
    await ensureCliReady();
    if (!requireCredential) return;
    const resolvedBinary =
      cliVerdict?.result.kind === "system" ||
      cliVerdict?.result.kind === "managed"
        ? cliVerdict.result.binary
        : undefined;
    // 二进制换了（首次 status 前尚未解析，或用旧路径失败过）就作废旧结论重试。
    if (initResult && initBinary !== resolvedBinary) initResult = undefined;
    if (!initResult?.ok) {
      initResult = await initializeKnowledge(initOptions);
      initBinary = resolvedBinary;
      // 凭据可能被用户/jev 插件刚配好：失败不缓存，成功则解除降级短路。
      credentialMissing = !initResult.ok;
    }
    if (!initResult.ok) {
      throw new KnowledgeServiceError(
        "service_unavailable",
        initResult.reason ?? "检索服务未就绪。",
      );
    }
  }

  async function listRoots(listOptions?: {
    timeoutMs?: number;
    retries?: number;
  }): Promise<KnowledgeRoot[]> {
    await assertReady(false);
    const timeoutMs = resolveGovernanceNumber(
      "knowledgeListTimeoutMs",
      listOptions?.timeoutMs,
    );
    // 只对超时做有限重试：上游 service 冷启动可能超过一次预算，参数/执行错误不重放。
    let attempts =
      resolveGovernanceNumber("knowledgeListRetries", listOptions?.retries) + 1;
    let result = await options.runner({
      args: ["list", "--json"],
      timeoutMs,
    });
    while (result.code === SAG_EXIT_TIMEOUT && attempts > 1) {
      attempts -= 1;
      result = await options.runner({ args: ["list", "--json"], timeoutMs });
    }
    assertOk(result, "列出知识库根");
    const roots = decode(result, "列出知识库根", sagListOutputSchema);
    return roots.map((root) => ({ ...root, error: root.error ?? null }));
  }

  /**
   * 真正的检索编排（不含降级决策）：校验 → 参数 → 单根或无 path 全根遍历。
   * `localMatch` 经入参决定走语义档还是 `-F` 档。
   */
  async function doSearch(
    input: KnowledgeSearchInput,
  ): Promise<KnowledgeSearchResult> {
    await assertReady(!input.localMatch);
    const query = input.query.trim();
    if (!query || query.length > SAG_QUERY_MAX_CHARS) {
      throw new KnowledgeServiceError(
        "invalid_input",
        `检索问题须为 1–${SAG_QUERY_MAX_CHARS} 字符。`,
      );
    }
    const maxResults = resolveGovernanceNumber(
      "knowledgeMaxResults",
      input.maxResults ?? options.defaultMaxResults,
    );
    const timeoutMs =
      input.timeoutMs === undefined
        ? undefined
        : resolveGovernanceNumber("knowledgeSearchTimeoutMs", input.timeoutMs);
    const runSearch = async (path: string | undefined) => {
      // -c 取正文（0.1.8 帮助实测：语义默认含正文；-E/-F 需显式 -c）。
      // 本地档用 -E 正则 + 关键词：-F 是整串匹配，自然语句必然零命中（真机踩到）。
      const args = input.localMatch
        ? [
            "-E",
            buildLocalMatchPattern(query),
            "-c",
            ...(path ? [path] : []),
            "--json",
          ]
        : [
            query,
            "--json",
            "-m",
            String(maxResults),
            "-c",
            ...(path ? ["--path", path] : []),
          ];
      const result = await options.runner({
        args,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      assertOk(result, input.localMatch ? "本地匹配" : "SAG2 语义检索");
      if (input.localMatch) {
        const output = decode(result, "本地匹配", sagMatchOutputSchema);
        return {
          scope: output.scope,
          results: output.results.map(toKnowledgeEvidence),
          truncated: output.truncated,
        };
      }
      const output = decode(result, "SAG2 语义检索", sagSearchOutputSchema);
      return {
        scope: output.scope,
        results: output.results.map(toKnowledgeEvidence),
        truncated: output.truncated,
      };
    };
    if (input.path) return runSearch(input.path);
    // 无 path 时上游按进程 cwd 划定范围（实测：cwd 不在任何根下直接 exit 1）。
    // 宿主语义是「检索知识库」，改为遍历全部已注册根并合并（调用方预算仍然生效）。
    // 目录清单用 list 自己的冷启动预算（默认 120s），不复用检索超时。
    const roots = await listRoots();
    if (roots.length === 0) {
      return { scope: "", results: [], truncated: false };
    }
    const merged: KnowledgeEvidence[] = [];
    let truncated = false;
    for (const root of roots) {
      const result = await runSearch(root.path);
      merged.push(...result.results);
      truncated ||= result.truncated;
      if (merged.length >= maxResults) break;
    }
    const deduped = dedupeKnowledgeEvidence(merged);
    return {
      scope: roots.map((root) => root.path).join(";"),
      results: deduped.slice(0, maxResults),
      truncated: truncated || deduped.length > maxResults,
    };
  }

  return {
    async isActive() {
      return toGateVerdict(await inspect());
    },

    async status(): Promise<KnowledgeStatus> {
      const inspection = await inspect();
      // cliStatus 只读探测（不下载）：面板心跳不该反复触发网络。
      const probed = supported ? await options.cliStatus?.() : undefined;
      const cli = !supported
        ? "unsupported_platform"
        : (probed?.state ??
          (initResult?.cli === "available" ? "available" : "missing"));
      const degradedNote = (message: string) =>
        options.autoLocalFallback === false
          ? message
          : `${message} 当前以本地匹配档工作（不出本机，非语义检索）。`;
      const reason = !inspection.ok
        ? inspection.message
        : !supported
          ? "当前平台没有 SAG CLI 原生二进制（仅 Windows x64 与 macOS Apple Silicon）。"
          : initResult && !initResult.ok
            ? degradedNote(initResult.reason ?? "语义检索未就绪")
            : semanticFailureReason
              ? // 语义档实际跑失败过（如 key 失效）：仍然「能用」，但要如实说。
                // 只留可读要点：上游 stderr 常带长 JSON，原样透出会淹没面板。
                degradedNote(describeSemanticFailure(semanticFailureReason))
              : (probed?.reason ?? null);
      return {
        installed: inspection.installed,
        enabled: inspection.enabled,
        // 自动降级开着时，缺 Jev 凭据不影响「能用本地档检索」。
        active:
          inspection.ok &&
          supported &&
          (initResult?.ok !== false || options.autoLocalFallback !== false),
        cli,
        cliVersion: SAG_CLI_VERSION,
        reason,
      };
    },

    async initialize() {
      const cli = supported ? await ensureCliReady() : undefined;
      initResult = await initializeKnowledge(initOptions);
      initBinary = cli?.binary;
      credentialMissing = !initResult.ok;
      return initResult;
    },

    listRoots,

    async addRoot(
      input: KnowledgeAddRootInput,
    ): Promise<KnowledgeRootMutation> {
      await assertReady(false);
      if (!input.path.trim()) {
        throw new KnowledgeServiceError(
          "invalid_input",
          "知识库根路径不能为空。",
        );
      }
      const types =
        input.types ?? options.indexExtensions ?? KNOWLEDGE_INDEX_EXTENSIONS;
      const args = ["add", input.path, "--types", types.join(","), "--json"];
      const result = await options.runner({ args });
      assertOk(result, "注册知识库根");
      const output = decode(result, "注册知识库根", sagAddOutputSchema);
      userRemovedRoots.delete(normalizeKnowledgeRootPath(output.path));
      rootsRevision += 1;
      return {
        path: output.path,
        indexStatus: output.index_status,
        cliAuthorized: output.cli_authorized,
      };
    },

    async removeRoot(path: string): Promise<KnowledgeRootMutation> {
      await assertReady(false);
      if (!path.trim()) {
        throw new KnowledgeServiceError(
          "invalid_input",
          "知识库根路径不能为空。",
        );
      }
      const result = await options.runner({
        args: ["remove", path, "--json"],
      });
      assertOk(result, "移除知识库根");
      const output = decode(result, "移除知识库根", sagRemoveOutputSchema);
      userRemovedRoots.add(normalizeKnowledgeRootPath(output.path));
      rootsRevision += 1;
      return output;
    },

    async ensureRoot(path: string): Promise<KnowledgeEnsureResult> {
      await assertReady(false);
      if (userRemovedRoots.has(normalizeKnowledgeRootPath(path))) {
        return {
          path,
          action: "rejected",
          reason:
            "该目录已被你从知识库移除，不自动重新注册；可在侧边栏显式添加。",
        };
      }
      const result = await ensureKnowledgeRoot(initOptions, path);
      if (result.action === "added") rootsRevision += 1;
      return result;
    },

    async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
      // 本地匹配档是显式降级（KB-4）：纯本地、不需 Jev，故不要求凭据就绪。
      const wantLocal = input.localMatch === true;
      if (!wantLocal && options.autoLocalFallback !== false) {
        // 0 配置优先：语义档不可用（缺 Jev 凭据/初始化失败）时自动退到本地档，
        // 由调用方在证据块里如实标注「本地匹配，非语义检索」。
        // 已知缺凭据时直接走本地档：避免每轮都先白等一次语义超时（真机实测 30s）。
        if (credentialMissing) {
          return {
            ...(await doSearch({ ...input, localMatch: true })),
            degraded: "local-match",
          };
        }
        // 首轮也先便宜地探一次凭据（读宿主/上游配置，不发起检索），缺了就不必等超时。
        await probeCredentialAvailability();
        if (credentialMissing) {
          return {
            ...(await doSearch({ ...input, localMatch: true })),
            degraded: "local-match",
          };
        }
        try {
          return { ...(await doSearch(input)), degraded: undefined };
        } catch (error) {
          const unavailable =
            error instanceof KnowledgeServiceError &&
            error.code === "service_unavailable" &&
            // 语义档不可用都算：未配置 / 凭据失效（401 Invalid API Key）/ JEV 请求失败。
            // 凭据失效尤其常见（换了 key、jev 条目被删），此时静默返回 0 条 = 假装检索过。
            /JEV|Jev|jev|凭据|未配置|401|Invalid API Key|unauthor|模型请求失败/iu.test(
              error.message,
            );
          if (!unavailable) throw error;
          credentialMissing = true;
          semanticFailureReason = error.message;
          return {
            ...(await doSearch({ ...input, localMatch: true })),
            degraded: "local-match",
          };
        }
      }
      return doSearch(input);
    },
    async read(input: KnowledgeReadInput): Promise<KnowledgeReadResult> {
      await assertReady(false);
      const path = input.path.trim();
      if (!path || !isAbsolute(path)) {
        throw new KnowledgeServiceError(
          "invalid_input",
          "取原文的路径必须是绝对路径（用证据里的 absolutePath）。",
        );
      }
      const startLine = Math.max(1, Math.floor(input.startLine ?? 1));
      const endLine =
        input.endLine === undefined ? undefined : Math.floor(input.endLine);
      if (endLine !== undefined && endLine < startLine) {
        throw new KnowledgeServiceError(
          "invalid_input",
          "结束行号不能小于起始行号。",
        );
      }
      const roots = await listRoots();
      let realPath: string;
      try {
        realPath = await realpath(path);
      } catch {
        throw new KnowledgeServiceError(
          "invalid_input",
          `文件不存在或不可读：${path}`,
        );
      }
      // 符号链接不扩权：realpath 后仍须落在某个已注册根内。
      const insideRoot = await Promise.all(
        roots.map(async (root) => {
          try {
            const realRoot = await realpath(root.path);
            const tail = relative(realRoot, realPath);
            return (
              tail !== "" &&
              !isAbsolute(tail) &&
              tail !== ".." &&
              !tail.startsWith(`..${sep}`)
            );
          } catch {
            return false;
          }
        }),
      );
      if (!insideRoot.some(Boolean)) {
        throw new KnowledgeServiceError(
          "invalid_input",
          "路径不在任何已注册的知识库根内；只能取检索证据指向的原文。",
        );
      }
      const maxBytes = resolveGovernanceNumber(
        "knowledgeReadMaxBytes",
        input.maxBytes,
      );
      const info = await stat(realPath);
      if (!info.isFile()) {
        throw new KnowledgeServiceError(
          "invalid_input",
          `不是普通文件：${path}`,
        );
      }
      const bytes = Math.min(info.size, maxBytes);
      const buffer = Buffer.alloc(bytes);
      const handle = await open(realPath, "r");
      try {
        await handle.read(buffer, 0, bytes, 0);
      } finally {
        await handle.close();
      }
      const lines = buffer.toString("utf8").split(/\r?\n/u);
      const slice = lines.slice(
        startLine - 1,
        endLine === undefined ? lines.length : endLine,
      );
      return {
        path,
        content: slice.join("\n"),
        truncated: info.size > maxBytes,
      };
    },

    rootsRevision() {
      return rootsRevision;
    },

    async library() {
      const root = await library.path();
      return { root, files: await library.list() };
    },

    async uploadFile(input) {
      const saved = await library.save(input.name, input.bytes);
      const root = await library.path();
      // 托管目录作为唯一根：首次上传即注册并索引（幂等）。
      // 注意不能用对象上的 ensureRoot（闭包里拿不到），走内部编排并保持墓碑语义。
      await assertReady(false);
      const tombstoned = userRemovedRoots.has(normalizeKnowledgeRootPath(root));
      const ensured: KnowledgeEnsureResult = tombstoned
        ? {
            path: root,
            action: "rejected",
            reason: "该目录已被你移除，不自动重新注册；可在侧边栏显式添加。",
          }
        : await ensureKnowledgeRoot(initOptions, root);
      if (ensured.action === "added") rootsRevision += 1;
      return {
        file: saved,
        root,
        indexed:
          ensured.action === "added" || ensured.action === "already-indexed",
      };
    },
  };
}
