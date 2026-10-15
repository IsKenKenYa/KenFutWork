import type { PluginDefinition } from "../../kernel/types.js";
import { type JobLoopService, startJobLoop } from "./job-loop.js";

// 执行器归所属feature装配；service本身不另建注册路径或消费循环。
import "./executors/image-generation.js";
import "./executors/video-generation.js";

export function createJobLoopPlugin(options: {
  enabled: NonNullable<PluginDefinition["enabled"]>;
  tag?: string;
}): PluginDefinition {
  return {
    name: "jobLoop",
    enabled: options.enabled,
    inject: [
      "assetWriter",
      "uploads",
      "blob",
      "jobs",
      "modelProviders",
      "queue",
      "usage",
      "projectFiles",
      "generationTargets",
    ],
    apply(ctx) {
      let loop: JobLoopService | undefined;
      ctx.register("jobLoop", () => {
        loop ??= startJobLoop(
          {
            env: ctx.env,
            assetWriter: ctx.get("assetWriter"),
            uploads: ctx.get("uploads"),
            blob: ctx.get("blob"),
            jobService: ctx.get("jobs"),
            modelProviders: ctx.get("modelProviders"),
            queue: ctx.get("queue"),
            usageService: ctx.get("usage"),
            projectFiles: ctx.get("projectFiles"),
            generationTargets: ctx.get("generationTargets"),
          },
          options.tag ? { tag: options.tag } : {},
        );
        return loop;
      });
      ctx.effect(() => async () => {
        await loop?.shutdown();
      });
    },
  };
}
