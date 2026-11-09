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
  /** 只读 CLI 探测（不触发下载），供状态接口展示。 */
  cliStatus?: () => Promise<{
    state: "available" | "missing" | "unsupported_platform";
    reason: string | null;
  }>;
}

/** CLI 缺失/下载失败的重试冷却：离线时避免每轮对话都卡在下载超时上。 */
const CLI_RETRY_COOLDOWN_MS = 300_000;

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
  const initOptions: KnowledgeInitOptions = {
    runner: options.runner,
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

  async function ensureCliReady(): Promise<void> {
    if (!options.ensureCli) return;
    const now = Date.now();
    if (cliVerdict && cliVerdict.result.kind !== "missing") return;
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
    if (!initResult?.ok) {
      initResult = await initializeKnowledge(initOptions);
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
      // -c 取正文（0.1.8 帮助实测：语义默认含正文；-F/-E 需显式 -c）；
      // -F 形状按探针实采（位置参数 + --json）。
      const args = input.localMatch
        ? ["-F", query, "-c", ...(path ? [path] : []), "--json"]
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
      const reason = !inspection.ok
        ? inspection.message
        : !supported
          ? "当前平台没有 SAG CLI 原生二进制（仅 Windows x64 与 macOS Apple Silicon）。"
          : initResult && !initResult.ok
            ? // 有自动降级时，缺凭据不是「不可用」，而是「降级可用」。
              options.autoLocalFallback === false
              ? initResult.reason
              : `${initResult.reason ?? "语义检索未就绪"} 当前以本地匹配档工作（不出本机，非语义检索）。`
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
      initResult = await initializeKnowledge(initOptions);
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
        // 0 配置优先：语义档不可用（缺 Jev 凭据/初始化失败）时自动退到 -F，
        // 由调用方在证据块里如实标注「本地匹配，非语义检索」。
        try {
          return { ...(await doSearch(input)), degraded: undefined };
        } catch (error) {
          const unavailable =
            error instanceof KnowledgeServiceError &&
            error.code === "service_unavailable" &&
            /JEV|Jev|凭据|未配置/.test(error.message);
          if (!unavailable) throw error;
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
  };
}
