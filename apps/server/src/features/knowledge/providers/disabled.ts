/**
 * 「尚未接 CLI」的 KnowledgeService Provider（M1 保留，M2 起不再由 profile 装配）。
 *
 * 仍满足完整 Definition，供只关心门控/状态的最小装配与回归测试使用。
 * 「Disabled」不是静默返回 null：状态如实上报，其余能力一律抛显式错误
 * （KB-4：fail loud，绝不假装检索过）。
 */

import {
  isSagCliPlatformSupported,
  SAG_CLI_VERSION,
} from "../sag-cli-contract.js";
import {
  createBundleInspector,
  type PluginsServiceLike,
  toGateVerdict,
} from "../service.js";
import {
  type KnowledgeService,
  KnowledgeServiceError,
  type KnowledgeStatus,
} from "../types.js";

export interface DisabledKnowledgeProviderOptions {
  /** 延迟取插件注册表，避免注册期依赖装配顺序。 */
  tryGetPlugins: () => PluginsServiceLike | undefined;
  platform?: NodeJS.Platform;
  arch?: string;
}

export function createDisabledKnowledgeProvider(
  options: DisabledKnowledgeProviderOptions,
): KnowledgeService {
  const inspect = createBundleInspector(options.tryGetPlugins);
  const supported = isSagCliPlatformSupported(options.platform, options.arch);

  function unavailable(): never {
    throw new KnowledgeServiceError(
      "service_unavailable",
      "知识库检索服务尚未接入 SAG CLI：请先安装 SAG2 知识库插件并确认 CLI 可用。",
    );
  }

  return {
    async isActive() {
      return toGateVerdict(await inspect());
    },

    async status(): Promise<KnowledgeStatus> {
      const inspection = await inspect();
      const cli = supported ? "missing" : "unsupported_platform";
      const reason = !inspection.ok
        ? inspection.message
        : supported
          ? "知识库检索服务尚未接入 SAG CLI。"
          : "当前平台没有 SAG CLI 原生二进制（仅支持 Windows x64 与 macOS Apple Silicon）。";
      return {
        installed: inspection.installed,
        enabled: inspection.enabled,
        active: false,
        cli,
        cliVersion: SAG_CLI_VERSION,
        reason,
      };
    },

    async initialize() {
      return {
        ok: false,
        credential: "missing" as const,
        cli: supported
          ? ("missing" as const)
          : ("unsupported_platform" as const),
        reason: "知识库检索服务尚未接入 SAG CLI。",
      };
    },

    async listRoots(_options?: { timeoutMs?: number; retries?: number }) {
      return unavailable();
    },
    async addRoot() {
      return unavailable();
    },
    async removeRoot() {
      return unavailable();
    },
    async ensureRoot() {
      return unavailable();
    },
    async search() {
      return unavailable();
    },
    async read() {
      return unavailable();
    },
    rootsRevision() {
      return 0;
    },
  };
}
