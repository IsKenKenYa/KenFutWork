import { join } from "node:path";
import { resolveDesktopDataDir } from "../../desktop/paths.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createLocalInstanceRepository } from "./repository.js";
import { bindLocalInstanceDataRoot } from "./root-binding.js";
import { createLocalInstanceService } from "./service.js";

/** 启动期实例引导，与任何HTTP请求、账户或商业服务无关。 */
export function createLocalInstancePlugin(
  options: { withHttpLifecycle?: boolean } = {},
): PluginDefinition {
  return {
    name: "local-instance",
    inject: ["persistence"],
    apply(ctx) {
      ctx.register("localInstance", () =>
        createLocalInstanceService({
          repository: createLocalInstanceRepository(ctx.get("persistence")),
          dataDir: resolveDesktopDataDir({
            env: {
              KENFUTWORK_DATA_DIR: ctx.env.desktopDataDir,
            },
          }),
          bindRoot: (instanceId, dataDir) =>
            bindLocalInstanceDataRoot({
              persistence: ctx.get("persistence"),
              instanceId,
              dataDir,
              ...(ctx.env.gitBinDir
                ? {
                    gitBinary: join(
                      ctx.env.gitBinDir,
                      process.platform === "win32" ? "git.exe" : "git",
                    ),
                  }
                : {}),
            }),
        }),
      );
    },
    mounted(ctx) {
      if (options.withHttpLifecycle === false) return;
      ctx.app.addHook("onReady", async () => {
        await ctx.get("localInstance").getContext();
      });
    },
  };
}
