import { expect, it, vi } from "vitest";
import { loadServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import type { ServiceMap } from "../../kernel/types.js";
import { createCheckpointsPlugin } from "./plugin.js";

vi.mock("../../http/checkpoints.js", () => ({
  registerCheckpointsRoutes: vi.fn(async () => {}),
}));

it("检查点与共享Task宿主可装配，不在初始化时取得恢复宿主", async () => {
  let runtimeCheckpoints: ServiceMap["checkpoints"] | undefined;
  const kernel = composePlugins(
    loadServerEnv({}, {}),
    [
      createCheckpointsPlugin(),
      {
        name: "runtime-fixture",
        inject: [],
        apply(ctx) {
          ctx.register("agentRuns", () => {
            runtimeCheckpoints = ctx.get("checkpoints");
            return {} as ServiceMap["agentRuns"];
          });
          ctx.register("codeUi", () => {
            ctx.get("agentRuns");
            return {} as ServiceMap["codeUi"];
          });
        },
      },
    ],
    {
      app: {} as never,
      overrides: {
        persistence: {} as ServiceMap["persistence"],
        localAccess: {} as ServiceMap["localAccess"],
        settings: {} as ServiceMap["settings"],
        processSandbox: {} as ServiceMap["processSandbox"],
        executionScopes: {
          onRevoke: () => () => {},
        } as unknown as ServiceMap["executionScopes"],
      },
    },
  );
  expect(runtimeCheckpoints).toBe(kernel.get("checkpoints"));
  await kernel.dispose();
});
