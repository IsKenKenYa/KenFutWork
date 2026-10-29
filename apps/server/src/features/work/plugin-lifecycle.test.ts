import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../kernel/types.js";
import { createWorkHostPlugin } from "./plugin.js";

/**
 * Work 插件的工具接线：EDA 三个工具必须真的交给内核（`registerDynamic`），
 * 并且写工具在只读沙箱下不可见——否则「agent 能改原理图」会在只读任务里穿透。
 */

const SAMPLE = `(kicad_sch
  (version 20231120)
  (lib_symbols)
  (symbol
    (lib_id "Device:R")
    (at 120 100 0)
    (property "Reference" "R1" (at 122 98 0))
    (property "Value" "10k" (at 122 101 0))
  )
)
`;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 最小 ctx：只提供 Work 插件用到的面（tools / localAccess / app / env / effect）。 */
async function mount(dataDir: string) {
  const app = Fastify();
  const registrations: Array<{
    id: string;
    resolve: (run: unknown) => ToolDefinition | null;
  }> = [];
  const ctx = {
    env: { desktopDataDir: dataDir },
    app,
    effect: (fn: () => unknown) => fn(),
    get: (key: string) => {
      if (key === "tools")
        return {
          registerDynamic: (def: {
            id: string;
            resolve: (run: unknown) => ToolDefinition | null;
          }) => {
            registrations.push(def);
            return () => {};
          },
        };
      if (key === "localAccess")
        return { authenticate: async () => null, onRevoked: () => () => {} };
      throw new Error(`未提供的服务：${key}`);
    },
  };
  createWorkHostPlugin().mounted?.(ctx as never);
  await app.ready();
  return { app, registrations };
}

function run(mode: "read-only" | "workspace-write") {
  return {
    scopeHandle: {
      role: "main",
      describe: () => ({ sandboxMode: mode }),
    },
  };
}

describe("Work 插件的 EDA 工具接线", () => {
  it("把三个 EDA 工具交给内核，且写工具只对可写任务可见", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kfw-work-tools-"));
    dirs.push(dir);
    const { app, registrations } = await mount(dir);
    try {
      expect(registrations.map((def) => def.id).sort()).toEqual([
        "work.eda_parts",
        "work.eda_read",
        "work.eda_write",
      ]);
      const writable = registrations.map((def) => def.resolve(run("workspace-write"))?.name);
      expect(writable).toEqual(["eda_read", "eda_parts", "eda_write"]);
      const readOnly = registrations.map((def) => def.resolve(run("read-only"))?.name ?? null);
      expect(readOnly).toEqual(["eda_read", "eda_parts", null]);
      // 非主 run（子代理）不拿这些工具：原理图是主会话的工作面。
      expect(registrations[0]?.resolve({ scopeHandle: { role: "subagent" } })).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("经内核解析出来的工具能真的写读同一份原理图", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kfw-work-tools-"));
    dirs.push(dir);
    const { app, registrations } = await mount(dir);
    try {
      const write = registrations
        .map((def) => def.resolve(run("workspace-write")))
        .find((tool) => tool?.name === "eda_write");
      const read = registrations
        .map((def) => def.resolve(run("workspace-write")))
        .find((tool) => tool?.name === "eda_read");
      if (!write || !read) throw new Error("EDA 工具没有出现在 run 的可用工具里");

      await write.execute({ text: SAMPLE }, {} as never);
      expect(
        await readFile(join(dir, "work", "eda", "schematic.kicad_sch"), "utf8"),
      ).toBe(SAMPLE);

      const back = (await read.execute({}, {} as never)) as {
        content: Array<{ text: string }>;
      };
      expect(back.content[0]?.text).toBe(SAMPLE);
    } finally {
      await app.close();
    }
  });
});
