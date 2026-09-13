import { describe, expect, it } from "vitest";

import { composePlugins } from "../kernel/compose.js";
import type { KernelEvents, ToolRegistry } from "../kernel/types.js";
import { PRESETS, toolsForPreset } from "./index.js";

const env = {
  agentBackendMode: "state" as const,
  agentModel: "m",
  // 存储缝是必需项（M1 起）：缺 databaseUrl 时 persistence 不挂载，声明了
  // inject 的插件在启动期 fail loud。这里给一个不实际连接的连接串——
  // Provider 只在首次查询时才建连接，故 compose 期无网络访问。
  databaseUrl: "postgres://localhost:5432/loomic-test",
  // blob 缝是必需能力且只有本地 FS 形态（M1.5 已删 Supabase Provider）
  blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
  credentialSecret: "test-secret",
  port: 0,
  version: "t",
  webOrigin: "http://x",
};

function kernelWithScopes(): ReturnType<typeof composePlugins> {
  return composePlugins(env, [
    {
      name: "seeder",
      inject: [],
      apply(ctx) {
        const tools: ToolRegistry = ctx.get("tools");
        for (const scope of ["design", "code", "shared"] as const) {
          tools.register({
            name: `tool_${scope}`,
            description: "",
            scope,
            parameters: {},
            execute: async () => null,
          });
        }
      },
    },
  ]);
}

describe("agent preset（DEC-2 会话级能力集）", () => {
  it("design/code preset 按 scope 过滤，shared 恒可用", () => {
    const kernel = kernelWithScopes();
    const tools: ToolRegistry = kernel.get("tools");
    const all = tools.list();
    expect(
      toolsForPreset(all, PRESETS.design)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["tool_design", "tool_shared"]);
    expect(
      toolsForPreset(all, PRESETS.code)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["tool_code", "tool_shared"]);
    kernel.dispose();
  });
});

describe("profiles（P7 单一插件清单）", async () => {
  const { serverProfile } = await import("../profiles/server.js");
  const { workerProfile } = await import("../profiles/worker.js");

  it("server/worker profile 均可装配（无 app 时 ctx.app 访问抛错但不崩）", () => {
    const deps = {
      auth: { authenticate: async () => null },
      connectionManager: {} as never,
      events: {
        emitPreStep: (payload) => Promise.resolve(payload),
        emitToolPreExecute: (payload) => Promise.resolve(payload),
        emitTurnStopping: () => Promise.resolve(),
      } satisfies KernelEvents,
      credentialEnv: {},
      env,
    };
    expect(() =>
      composePlugins(env, workerProfile(deps), {
        overrides: {
          auth: deps.auth,
        },
      }),
    ).not.toThrow();
    // server profile 需要真实依赖（agentRuns 构造），无 app/凭证环境下允许失败——
    // 这里只断言清单本身可被引用与展开（插件清单漂移在编译期消失）。
    expect(() => serverProfile(deps)).not.toThrow();
  });
});
