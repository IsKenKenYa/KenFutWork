import { registerVoiceRoutes } from "../../http/voice.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { resolveVoiceModelsRoot } from "./builtin-models.js";
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
  return {
    name: "voice",
    inject: ["auth", "modelProviders", "persistence", "viewer"],
    apply(ctx) {
      const modelsRoot = options.modelsRoot ?? resolveVoiceModelsRoot(ctx.env);
      ctx.register("voice", (deps) =>
        createVoiceService({
          repository: createVoiceRepository(deps.get("persistence")),
          modelProviders: deps.get("modelProviders"),
          modelsRoot,
        }),
      );
    },
    mounted(ctx) {
      void registerVoiceRoutes(ctx.app, {
        auth: ctx.get("auth"),
        voiceService: ctx.get("voice"),
        viewerService: ctx.get("viewer"),
      });
    },
  };
}
