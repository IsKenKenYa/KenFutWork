/**
 * SAG2 知识库插件（宿主内核层，M3）。
 *
 * - **默认挂载**：不写 `enabled` 判定（`plugin.enabled?.(env) ?? true`，
 *   `kernel/compose.ts:58`）。真正的开关是市场 bundle 的安装态，见 `service.ts`。
 * - **能力缝三元组**：Definition = `types.ts::KnowledgeService`；
 *   Provider = `providers/sag-cli.ts`；Consumer = pre-step preflight +
 *   置顶提示段 + shared 工具 + `http/knowledge.ts` 路由（M4 加侧边栏面板）。
 * - 凭据经 `modelProviders.resolveCredentialsById()` 后台路径取，
 *   只在 `--key-stdin` 的 stdin 里出现，不进 argv / 日志 / 事件（`DEC-7`）。
 * - `apply` 只注册自己的服务，跨服务接线（HTTP 路由）放 `mounted`。
 * - ctx key `knowledge` 的唯一权威表是《改造计划》§4.2，代码侧只改
 *   `kernel/types.ts::ServiceMap` 一处。
 */

import { registerKnowledgeRoutes } from "../../http/knowledge.js";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  createKnowledgePreflight,
  createRunRootResolver,
  type KnowledgePreflightController,
} from "./preflight.js";
import { createKnowledgePromptSection } from "./prompt.js";
import { createSagCliProvider } from "./providers/sag-cli.js";
import { createProcessSagRunner, type SagRunner } from "./sag-cli-runner.js";
import type { PluginsServiceLike } from "./service.js";
import { createKnowledgeSettingsReader } from "./settings.js";
import { createKnowledgeToolEntries } from "./tools.js";
import { KNOWLEDGE_JEV_PROVIDER_ID } from "./types.js";

export interface KnowledgePluginOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** 测试注入；生产用 `createProcessSagRunner()`。 */
  runner?: SagRunner;
  /** 测试注入；生产从 `modelProviders` 后台路径取。 */
  readJevCredential?: () => Promise<string | null>;
  indexExtensions?: readonly string[];
}

export function createKnowledgePlugin(
  options: KnowledgePluginOptions = {},
): PluginDefinition {
  let preflightController: KnowledgePreflightController | undefined;
  return {
    name: "knowledge",
    inject: ["plugins"],
    apply(ctx) {
      // `modelProviders` 在 serverProfile 里先于本插件装配；用 tryGet 让
      // 最小装配 / 测试也能挂载，缺实例时由状态接口给出引导，不擅自创建。
      const modelProviders = ctx.tryGet("modelProviders");
      const readJevCredential =
        options.readJevCredential ??
        (async () => {
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

      ctx.register("knowledge", (deps) =>
        createSagCliProvider({
          runner: options.runner ?? createProcessSagRunner(),
          tryGetPlugins: () =>
            deps.get("plugins") as PluginsServiceLike | undefined,
          readJevCredential,
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
    },
    mounted(ctx) {
      const localAccess = ctx.tryGet("localAccess");
      const localInstance = ctx.tryGet("localInstance");
      // worker / 最小装配没有本机接入与 HTTP 面，跳过路由注册。
      if (!localAccess || !localInstance) return;
      void registerKnowledgeRoutes(ctx.app, {
        localAccess,
        localInstance,
        knowledge: ctx.get("knowledge"),
        ...(preflightController ? { preflight: preflightController } : {}),
      });
    },
  };
}
