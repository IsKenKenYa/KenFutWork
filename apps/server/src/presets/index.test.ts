import { describe, expect, it } from "vitest";
import { createLocalInstanceService } from "../features/local-instance/service.js";
import type { PostgresQueryRunner } from "../features/persistence/providers/postgres.js";
import { createPersistenceFromRunner } from "../features/persistence/providers/postgres.js";

import { composePlugins } from "../kernel/compose.js";
import type { KernelEvents, ToolRegistry } from "../kernel/types.js";
import { PRESETS, toolsForPreset } from "./index.js";

const env = {
  agentBackendMode: "state" as const,
  agentModel: "m",
  // 存储缝是必需项（M1 起）：缺 databaseUrl 时 persistence 不挂载，声明了
  // inject 的插件在启动期 fail loud。这里给一个不实际连接的连接串——
  // Provider 只在首次查询时才建连接，故 compose 期无网络访问。
  databaseUrl: "postgres://localhost:5432/kenfutwork-test",
  // blob 缝是必需能力且只有本地 FS 形态（M1.5 已删 Supabase Provider）
  blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
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

  it("worker Project Provider reads scoped projects and denies archive for every kind", async () => {
    const instanceId = "worker-instance";
    const actor = { instanceId, accessClientId: null };
    const rows = new Map([
      ["project-code", { id: "project-code", kind: "code" }],
      ["project-design", { id: "project-design", kind: "design" }],
      ["project-flow", { id: "project-flow", kind: "flow" }],
    ]);
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const query = async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      if (!/^\s*select\b/iu.test(text))
        throw new Error("worker read fixture rejected SQL mutation");
      const row = rows.get(String(values[0]));
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    };
    const runner: PostgresQueryRunner = {
      query,
      acquire: async () => ({ query, release() {} }),
      acquireSession: async () => {
        throw new Error("worker fixture does not open sessions");
      },
      end: async () => {},
    };
    const localInstance = createLocalInstanceService({
      repository: { ensure: async () => instanceId },
      dataDir: "/tmp/kenfut-worker-profile-test",
    });
    const worker = composePlugins(
      { ...env, queueDriver: "in-process" },
      workerProfile(),
      {
        overrides: {
          localInstance,
          persistence: createPersistenceFromRunner(runner),
        },
      },
    );

    try {
      const projects = worker.get("projects");
      for (const [projectId, kind] of [
        ["project-code", "code"],
        ["project-design", "design"],
        ["project-flow", "flow"],
      ] as const) {
        expect(await projects.getProject(actor, projectId)).toMatchObject({
          id: projectId,
          kind,
        });
        await expect(
          projects.archiveProject(actor, projectId),
        ).rejects.toMatchObject({
          code: "project_delete_failed",
          statusCode: 503,
        });
      }
      const projectQueries = calls.filter(({ text }) =>
        /^\s*select\b/iu.test(text),
      );
      expect(projectQueries).toHaveLength(3);
      expect(
        projectQueries.every(({ values }) => values.includes(instanceId)),
      ).toBe(true);
      expect(worker.get("jobLoop").inFlightCount()).toBe(0);
    } finally {
      await worker.dispose();
    }

    const deps = {
      connectionManager: {} as never,
      events: {
        emitPreStep: (payload) => Promise.resolve(payload),
        emitToolPreExecute: (payload) => Promise.resolve(payload),
        emitTurnStopping: () => Promise.resolve(),
      } satisfies KernelEvents,
      env,
    };
    expect(() => serverProfile(deps)).not.toThrow();
  });
});
