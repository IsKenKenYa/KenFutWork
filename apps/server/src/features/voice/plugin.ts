import { registerVoiceRoutes } from "../../http/voice.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { resolveVoiceModelsRoot } from "./builtin-models.js";
import { createVoiceModelStore, type VoiceModelStore } from "./model-store.js";
import { createVoiceRepository } from "./repository.js";
import { createVoiceService } from "./voice-service.js";

/**
 * voice 插件（内建，**默认开启**——《语音助手插件规划》§1.2）：
 * 进 profile 清单、**不写 `enabled` 判定**（内核是 `plugin.enabled?.(env) ?? true`），
 * 即默认挂载。用户侧的开关是**功能模式**（只转文本 / 完整回路），不是插件启停。
 *
 * 不做成市场插件的原因见规划 §1.3（市场插件只有 tools/systemPrompt/routes/ui 四项
 * 能力面、门禁禁止直连系统、bundle 不能带 npm 依赖、装卸要管理员）。
 *
 * 路由注册放 `mounted`（跨服务接线的约定位置，见 `kernel/types.ts`），
 * `apply` 只注册自己的服务。测试注入走 kernel `overrides` 替换 `voice` 实例。
 */
export function createVoicePlugin(
  options: { modelsRoot?: string } = {},
): PluginDefinition {
  /**
   * 下载器在 `apply` 里建、在 `mounted` 里用（compose 保证同插件的 apply 先于
   * mounted）：**服务与路由必须共用同一个实例**，否则下载进度状态对不上
   * （一个是「下载中」、另一个说「未下载」）。它是插件内部件而非可替换能力，
   * 故不进 ctx key 表（那张表只登记能力缝）。
   */
  let modelStore: VoiceModelStore | undefined;

  return {
    name: "voice",
    inject: ["auth", "modelProviders", "persistence", "viewer"],
    apply(ctx) {
      const modelsRoot = options.modelsRoot ?? resolveVoiceModelsRoot(ctx.env);
      const store = createVoiceModelStore({ modelsRoot });
      modelStore = store;
      ctx.register("voice", (deps) =>
        createVoiceService({
          repository: createVoiceRepository(deps.get("persistence")),
          modelProviders: deps.get("modelProviders"),
          modelsRoot,
          modelStore: store,
        }),
      );
    },
    mounted(ctx) {
      void registerVoiceRoutes(ctx.app, {
        auth: ctx.get("auth"),
        voiceService: ctx.get("voice"),
        viewerService: ctx.get("viewer"),
        ...(modelStore ? { modelStore } : {}),
      });
    },
  };
}
