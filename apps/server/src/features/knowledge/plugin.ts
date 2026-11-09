/**
 * SAG2 知识库插件（宿主内核层，M5）。
 *
 * - **默认挂载**：不写 `enabled` 判定（`plugin.enabled?.(env) ?? true`，
 *   `kernel/compose.ts:58`）。真正的开关是市场 bundle 的安装态，见 `service.ts`。
 * - **能力缝三元组**：Definition = `types.ts::KnowledgeService`；
 *   Provider = `providers/sag-cli.ts`；Consumer = pre-step preflight +
 *   置顶提示段 + shared 工具 + `http/knowledge.ts` 路由 + 侧边栏面板。
 * - **CLI 三级探测**（KB-5）：本机已装 `sag` → 数据目录自带（按需下载钉版本 +
 *   校验和）→ 显式 missing + 离线安装指引（`cli-install.ts`）。
 * - 凭据经 `modelProviders.resolveCredentialsById()` 后台路径取，
 *   只在 `--key-stdin` 的 stdin 里出现，不进 argv / 日志 / 事件（`DEC-7`）。
 * - `apply` 只注册自己的服务，跨服务接线（HTTP 路由）放 `mounted`。
 * - ctx key `knowledge` 的唯一权威表是《改造计划》§4.2，代码侧只改
 *   `kernel/types.ts::ServiceMap` 一处。
 */

import { resolveDesktopDataDir } from "../../desktop/paths.js";
import { registerKnowledgeRoutes } from "../../http/knowledge.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { MCP_ENV_CREDENTIAL_CAPABILITY } from "../mcp/env-credential.js";
import { createSagCliInstaller, type SagCliResolution } from "./cli-install.js";
import {
  createKnowledgePreflight,
  createRunRootResolver,
  type KnowledgePreflightController,
} from "./preflight.js";
import { createKnowledgePromptSection } from "./prompt.js";
import { createSagCliProvider } from "./providers/sag-cli.js";
import { createProcessSagRunner, type SagRunner } from "./sag-cli-runner.js";
import type { PluginsServiceLike } from "./service.js";
import {
  createKnowledgeSettingsReader,
  type KnowledgeSettingsReader,
} from "./settings.js";
import { createKnowledgeToolEntries } from "./tools.js";
import {
  KNOWLEDGE_JEV_ENV_KEY,
  KNOWLEDGE_JEV_MCP_SERVER_NAME,
  KNOWLEDGE_JEV_PROVIDER_ID,
} from "./types.js";

export interface KnowledgePluginOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** 测试注入；生产用 `createProcessSagRunner()`。 */
  runner?: SagRunner;
  /** 测试注入；生产从 `modelProviders` 后台路径取。 */
  readJevCredential?: () => Promise<string | null>;
  indexExtensions?: readonly string[];
  /** 自带 CLI 落位根（缺省取桌面数据根）；测试传临时目录。 */
  dataDir?: string;
  /** 测试注入：CLI 探测（缺省 spawn `sag --build-info`）。 */
  probeCli?: (binary: string) => Promise<boolean>;
  /** 测试注入：tarball 下载（缺省全局 fetch）。 */
  fetchCliTarball?: typeof fetch;
}

export function createKnowledgePlugin(
  options: KnowledgePluginOptions = {},
): PluginDefinition {
  let preflightController: KnowledgePreflightController | undefined;
  let readSettingsForRoutes: KnowledgeSettingsReader | undefined;
  return {
    name: "knowledge",
    inject: ["plugins"],
    apply(ctx) {
      // `modelProviders` 在 serverProfile 里先于本插件装配；用 tryGet 让
      // 最小装配 / 测试也能挂载，缺实例时由状态接口给出引导，不擅自创建。
      const modelProviders = ctx.tryGet("modelProviders");
      /**
       * Jev 凭据来源链（0 配置优先）：
       * ① jev 插件配套的 MCP 条目 `TYPESAFE_API_KEY`（装了 jev 插件就能直接复用）
       * ② `modelProviders` 的 TypeSafe 实例（BYOK 设置页）
       * 都取不到 → null，由上层决定降级或报错；绝不擅自创建实例、不覆盖既有 SAG 配置。
       */
      const readJevCredential =
        options.readJevCredential ??
        (async () => {
          const fromMcp = await ctx
            .get("capabilities")
            .get<{
              readEnvValue(
                serverName: string,
                envKey: string,
              ): Promise<string | null>;
            }>(MCP_ENV_CREDENTIAL_CAPABILITY, "mcp:env-credential")
            ?.readEnvValue(KNOWLEDGE_JEV_MCP_SERVER_NAME, KNOWLEDGE_JEV_ENV_KEY)
            .catch(() => null);
          if (fromMcp) return fromMcp;
          if (!modelProviders) return null;
          try {
            const credentials = await modelProviders.resolveCredentialsById(
              KNOWLEDGE_JEV_PROVIDER_ID,
            );
            return credentials.apiKey;
          } catch {
            return null;
          }
        });

      // KB-5 三级探测：runner 的二进制路径在解析后才定（getter 延迟读取）。
      const dataDir =
        options.dataDir ??
        resolveDesktopDataDir({
          env: { KENFUTWORK_DATA_DIR: ctx.env.desktopDataDir },
        });
      let sagBinary: string | undefined;
      const installer = createSagCliInstaller({
        dataDir,
        ...(options.platform ? { platform: options.platform } : {}),
        ...(options.arch ? { arch: options.arch } : {}),
        ...(options.probeCli ? { probe: options.probeCli } : {}),
        ...(options.fetchCliTarball
          ? { fetchFn: options.fetchCliTarball }
          : {}),
      });
      const runner =
        options.runner ??
        createProcessSagRunner({ binary: () => sagBinary ?? "sag" });
      const ensureCli = async (): Promise<SagCliResolution> => {
        const result = await installer.resolve();
        if (result.kind === "system" || result.kind === "managed") {
          sagBinary = result.binary;
        }
        return result;
      };

      ctx.register("knowledge", (deps) =>
        createSagCliProvider({
          runner,
          tryGetPlugins: () =>
            deps.get("plugins") as PluginsServiceLike | undefined,
          readJevCredential,
          ensureCli,
          // 0 配置：语义档不可用时自动退本地匹配（治理可关）。
          autoLocalFallback:
            ctx.env.agentGovernance?.knowledgeAutoLocalFallback ?? true,
          cliStatus: async () => {
            const inspected = await installer.inspect();
            if (inspected.kind === "system" || inspected.kind === "managed") {
              return { state: "available", reason: null };
            }
            if (inspected.kind === "unsupported_platform") {
              return {
                state: "unsupported_platform",
                reason: inspected.reason,
              };
            }
            return {
              state: "missing",
              reason: `${inspected.reason} ${inspected.guidance}`,
            };
          },
          ...(options.platform ? { platform: options.platform } : {}),
          ...(options.arch ? { arch: options.arch } : {}),
          ...(options.indexExtensions
            ? { indexExtensions: options.indexExtensions }
            : {}),
        }),
      );

      // M3「优先调用」三层：pre-step preflight（主）+ 置顶提示段 + shared 工具。
      // persistence 缺席（最小装配）时设置落 env/默认、工作目录解析为空。
      const persistence = ctx.tryGet("persistence");
      const readSettings = createKnowledgeSettingsReader({
        persistence,
        env: ctx.env.agentGovernance,
      });
      const knowledge = ctx.get("knowledge");
      const preflight = createKnowledgePreflight({
        knowledge,
        readSettings,
        resolveRoot: createRunRootResolver(persistence),
      });
      ctx.on("pre-step", preflight.listener);
      ctx
        .get("systemPrompt")
        .register(createKnowledgePromptSection({ knowledge, readSettings }));
      const tools = ctx.get("tools");
      for (const entry of createKnowledgeToolEntries({
        knowledge,
        readSettings,
        tryGetPlugins: () =>
          ctx.tryGet("plugins") as PluginsServiceLike | undefined,
      })) {
        tools.registerDynamic(entry);
      }
      preflightController = preflight;
      readSettingsForRoutes = readSettings;
    },
    mounted(ctx) {
      const localAccess = ctx.tryGet("localAccess");
      const localInstance = ctx.tryGet("localInstance");
      // worker / 最小装配没有本机接入与 HTTP 面，跳过路由注册。
      if (!localAccess || !localInstance) return;
      const settings = ctx.tryGet("settings");
      void registerKnowledgeRoutes(ctx.app, {
        localAccess,
        localInstance,
        knowledge: ctx.get("knowledge"),
        ...(preflightController ? { preflight: preflightController } : {}),
        ...(readSettingsForRoutes
          ? { readSettings: readSettingsForRoutes }
          : {}),
        ...(settings
          ? {
              settings: {
                updateInstanceSettings:
                  settings.updateInstanceSettings.bind(settings),
              },
            }
          : {}),
      });
    },
  };
}
