/**
 * M2 的 KnowledgeService Provider：真实调用 `sag` CLI。
 *
 * - 安装态门控在**每次调用**时读（装／卸下一轮即生效）。
 * - 凭据初始化**懒执行且失败不缓存**：首次需要语义检索时才注入，失败如实上报。
 * - 纯本地命令（list/check/add/remove）不要求 Jev 凭据——知识库建库与
 *   「检索服务没配好」是两件事，不该互相阻断（KB-4：报错但不阻断）。
 * - 上游 stdout 一律经 zod 契约解析；字段漂移显式报错，不静默吞掉。
 */

import {
  ensureKnowledgeRoot,
  initializeKnowledge,
  type KnowledgeInitOptions,
  parseJsonOutput,
} from "../init.js";
import {
  isSagCliPlatformSupported,
  SAG_CLI_VERSION,
  SAG_EXIT,
  SAG_QUERY_MAX_CHARS,
  sagAddOutputSchema,
  sagListOutputSchema,
  sagRemoveOutputSchema,
  sagSearchOutputSchema,
  toKnowledgeEvidence,
} from "../sag-cli-contract.js";
import type { SagCommandResult, SagRunner } from "../sag-cli-runner.js";
import {
  createBundleInspector,
  type PluginsServiceLike,
  toGateVerdict,
} from "../service.js";
import {
  KNOWLEDGE_INDEX_EXTENSIONS,
  type KnowledgeAddRootInput,
  type KnowledgeEnsureResult,
  type KnowledgeInitResult,
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

  return {
    async isActive() {
      return toGateVerdict(await inspect());
    },

    async status(): Promise<KnowledgeStatus> {
      const inspection = await inspect();
      const cli = !supported
        ? "unsupported_platform"
        : initResult?.cli === "available"
          ? "available"
          : "missing";
      const reason = !inspection.ok
        ? inspection.message
        : initResult && !initResult.ok
          ? initResult.reason
          : !supported
            ? "当前平台没有 SAG CLI 原生二进制（仅 Windows x64 与 macOS Apple Silicon）。"
            : null;
      return {
        installed: inspection.installed,
        enabled: inspection.enabled,
        active: inspection.ok && supported && initResult?.ok !== false,
        cli,
        cliVersion: SAG_CLI_VERSION,
        reason,
      };
    },

    async initialize() {
      initResult = await initializeKnowledge(initOptions);
      return initResult;
    },

    async listRoots(): Promise<KnowledgeRoot[]> {
      await assertReady(false);
      const result = await options.runner({ args: ["list", "--json"] });
      assertOk(result, "列出知识库根");
      const roots = decode(result, "列出知识库根", sagListOutputSchema);
      return roots.map((root) => ({ ...root, error: root.error ?? null }));
    },

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
      return decode(result, "移除知识库根", sagRemoveOutputSchema);
    },

    async ensureRoot(path: string): Promise<KnowledgeEnsureResult> {
      await assertReady(false);
      return ensureKnowledgeRoot(initOptions, path);
    },

    async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
      await assertReady(true);
      const query = input.query.trim();
      if (!query || query.length > SAG_QUERY_MAX_CHARS) {
        throw new KnowledgeServiceError(
          "invalid_input",
          `检索问题须为 1–${SAG_QUERY_MAX_CHARS} 字符。`,
        );
      }
      const maxResults = input.maxResults ?? options.defaultMaxResults ?? 5;
      const args = [query, "--json", "-m", String(maxResults)];
      if (input.path) args.push("--path", input.path);
      const result = await options.runner({ args });
      assertOk(result, "SAG2 语义检索");
      const output = decode(result, "SAG2 语义检索", sagSearchOutputSchema);
      return {
        scope: output.scope,
        results: output.results.map(toKnowledgeEvidence),
        truncated: output.truncated,
      };
    },
  };
}
