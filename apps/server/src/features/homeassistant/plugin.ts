import { resolveDesktopDataDir } from "../../desktop/paths.js";
import { isDesktopRuntime } from "../../desktop/runtime.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { provisionHomeAssistant } from "./stack.js";

/**
 * HA 自带实例插件（`specs/ha-zero-config.md` 的「拉起」那一半）。
 *
 * 只做一件事：桌面形态启动后，在用户本机把 Home Assistant 容器拉起来，让
 * `kenfutwork-ha` 插件的自动接入有对象可接。接入本身（建所有者、签长期令牌）
 * 仍归插件——那条已经实现并带自愈。
 *
 * 不注册 ctx key：这条能力没有第二个消费方（插件按回环地址访问 HA，不经过宿主），
 * 按「能力缝三元组」的口径不需要 service definition；真出现消费方时再抽。
 */
export function createHomeAssistantStackPlugin(): PluginDefinition {
  return {
    name: "homeassistant-stack",
    inject: [],
    // 配置 fail loud：只有桌面形态（服务端与用户同机）才允许在本地建容器。
    enabled: (env) => isDesktopRuntime(env),
    apply() {
      // 全部作用面都在 mounted 的启动期任务里。
    },
    mounted(ctx) {
      const dataDir = resolveDesktopDataDir({
        env: {
          ...(ctx.env.desktopDataDir
            ? { KENFUTWORK_DATA_DIR: ctx.env.desktopDataDir }
            : {}),
        },
      });
      void provisionHomeAssistant({ dataDir, desktop: true })
        .then((result) => {
          if (result.action === "provisioned") {
            console.log(`[ha-stack] ${result.reason}`);
            return;
          }
          // skip 是常态（用户自建 HA、容器已在、没装 docker），按 info 记；
          // 真正的失败才 warn，且原因必须说清去哪儿改。
          console.log(`[ha-stack] 未拉起自带实例：${result.reason}`);
        })
        .catch((error: unknown) => {
          console.warn(
            "[ha-stack] 自带实例拉起异常：",
            error instanceof Error ? error.message : String(error),
          );
        });
    },
  };
}
