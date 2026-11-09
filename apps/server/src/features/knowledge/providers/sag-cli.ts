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
  /** 根集合修订号（KB-7 缓存键）：本插件驱动的根变更单调递增。 */
  let rootsRevision = 0;
  /**
   * 用户显式移除的根（墓碑）：preflight 的自动 ensureRoot 不得重加（§8.1）；
   * 侧边栏显式 addRoot 清除墓碑。只存规范化路径，不含文件元数据。
   */
  const userRemovedRoots = new Set<string>();

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

  async function listRoots(): Promise<KnowledgeRoot[]> {
    await assertReady(false);
    const result = await options.runner({ args: ["list", "--json"] });
    assertOk(result, "列出知识库根");
    const roots = decode(result, "列出知识库根", sagListOutputSchema);
    return roots.map((root) => ({ ...root, error: root.error ?? null }));
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
      // -c 取正文（M0：只有 -c 才返回 content）；-F 形状按探针实采（位置参数）。
      const args = input.localMatch
        ? ["-F", query, ...(input.path ? [input.path] : []), "--json"]
        : [
            query,
            "--json",
            "-m",
            String(maxResults),
            "-c",
            ...(input.path ? ["--path", input.path] : []),
          ];
      const result = await options.runner({
        args,
        ...(input.timeoutMs === undefined
          ? {}
          : {
              timeoutMs: resolveGovernanceNumber(
                "knowledgeSearchTimeoutMs",
                input.timeoutMs,
              ),
            }),
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
