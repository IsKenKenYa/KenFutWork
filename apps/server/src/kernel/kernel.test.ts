import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { ServerEnv } from "../config/env.js";
import { composePlugins } from "./compose.js";
import { ToolDeniedError } from "./context.js";
import type {
  CapabilityRegistry,
  PluginContext,
  PluginDefinition,
  ServiceMap,
  ToolRegistry,
} from "./types.js";

function makeEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "test-model",
    port: 0,
    version: "test",
    webOrigin: "http://localhost:3000",
    ...overrides,
  };
}

type Ctx = PluginContext;

function plugin(
  name: string,
  hooks: {
    inject?: ReadonlyArray<keyof ServiceMap>;
    enabled?: (env: ServerEnv) => boolean;
    onApply?: (ctx: Ctx) => void | (() => void);
  } = {},
): PluginDefinition {
  return {
    name,
    inject: hooks.inject ?? [],
    ...(hooks.enabled ? { enabled: hooks.enabled } : {}),
    apply(ctx) {
      return hooks.onApply?.(ctx);
    },
  };
}

describe("composePlugins 装配", () => {
  it("按声明顺序挂载，工厂依赖经 ctx.get 惰性解析", () => {
    const mounted: string[] = [];
    const kernel = composePlugins(makeEnv(), [
      plugin("viewer-plugin", {
        onApply(ctx) {
          mounted.push("viewer-plugin");
          ctx.register("viewer", () => ({ tag: "viewer-1" }) as never);
        },
      }),
      plugin("projects-plugin", {
        inject: ["viewer"],
        onApply(ctx) {
          mounted.push("projects-plugin");
          ctx.register("projects", (deps) => {
            const viewer = deps.get("viewer") as unknown as { tag: string };
            return { tag: viewer.tag } as never;
          });
        },
      }),
    ]);

    expect(mounted).toEqual(["viewer-plugin", "projects-plugin"]);
    expect((kernel.get("projects") as unknown as { tag: string }).tag).toBe(
      "viewer-1",
    );
    kernel.dispose();
  });

  it("声明顺序无关依赖：先声明插件的工厂可解析后声明插件提供的 key", () => {
    const kernel = composePlugins(makeEnv(), [
      plugin("consumer", {
        inject: ["settings"],
        onApply(ctx) {
          ctx.register("threads", (deps) => {
            const settings = deps.get("settings") as unknown as { ok: boolean };
            return { ok: settings.ok } as never;
          });
        },
      }),
      plugin("provider", {
        onApply(ctx) {
          ctx.register("settings", () => ({ ok: true }) as never);
        },
      }),
    ]);

    expect((kernel.get("threads") as unknown as { ok: boolean }).ok).toBe(true);
    kernel.dispose();
  });

  it("重复插件名 fail loud", () => {
    const same = plugin("dup");
    expect(() => composePlugins(makeEnv(), [same, same])).toThrow(
      /插件 dup 重复声明/,
    );
  });

  it("同一服务 key 被重复注册 fail loud", () => {
    const a = plugin("a", {
      onApply(ctx) {
        ctx.register("viewer", () => ({}) as never);
      },
    });
    const b = plugin("b", {
      onApply(ctx) {
        ctx.register("viewer", () => ({}) as never);
      },
    });
    expect(() => composePlugins(makeEnv(), [a, b])).toThrow(
      /服务 key viewer 被重复注册/,
    );
  });

  it("inject 声明的 key 无人提供 fail loud", () => {
    const needy = plugin("needy", { inject: ["chat"] });
    expect(() => composePlugins(makeEnv(), [needy])).toThrow(
      /插件 needy 声明依赖 chat/,
    );
  });

  it("循环依赖在启动期 fail loud", () => {
    const a = plugin("a", {
      inject: ["brandKit"],
      onApply(ctx) {
        ctx.register("viewer", (deps) => {
          deps.get("brandKit");
          return {} as never;
        });
      },
    });
    const b = plugin("b", {
      inject: ["viewer"],
      onApply(ctx) {
        ctx.register("brandKit", (deps) => {
          deps.get("viewer");
          return {} as never;
        });
      },
    });
    expect(() => composePlugins(makeEnv(), [a, b])).toThrow(/循环依赖/);
  });

  it("工厂在启动期定例化：实例化抛错即 compose 失败（fail loud）", () => {
    const boom = plugin("boom", {
      onApply(ctx) {
        ctx.register("uploads", () => {
          throw new Error("misconfigured");
        });
      },
    });
    expect(() => composePlugins(makeEnv(), [boom])).toThrow(/misconfigured/);
  });

  it("get 未注册 key fail loud", () => {
    const kernel = composePlugins(makeEnv(), [plugin("empty")]);
    expect(() => kernel.get("payments")).toThrow(/服务 key payments 未注册/);
    kernel.dispose();
  });

  it("enabled=false 的插件不挂载；enabled 收到 env", () => {
    const kernel = composePlugins(makeEnv(), [
      plugin("off", {
        enabled: (env) => env.webOrigin === "http://nowhere",
        onApply(ctx) {
          ctx.register("canvas", () => ({}) as never);
        },
      }),
    ]);
    expect(() => kernel.get("canvas")).toThrow(/服务 key canvas 未注册/);
    kernel.dispose();
  });

  it("overrides 优先于工厂", () => {
    const factorySpy = vi.fn(() => ({}) as never);
    const kernel = composePlugins(
      makeEnv(),
      [
        plugin("p", {
          inject: ["viewer"],
          onApply(ctx) {
            ctx.register("viewer", factorySpy);
          },
        }),
      ],
      { overrides: { viewer: { tag: "override" } as never } },
    );
    expect((kernel.get("viewer") as unknown as { tag: string }).tag).toBe(
      "override",
    );
    expect(factorySpy).not.toHaveBeenCalled();
    kernel.dispose();
  });

  it("dispose 逆序执行 apply 返回值与 effect 的 disposer", () => {
    const order: string[] = [];
    const kernel = composePlugins(makeEnv(), [
      plugin("p1", {
        onApply(ctx) {
          ctx.effect(() => {
            order.push("effect-1");
            return () => order.push("dispose-effect-1");
          });
          return () => order.push("dispose-p1");
        },
      }),
      plugin("p2", {
        onApply(ctx) {
          ctx.effect(() => {
            order.push("effect-2");
          });
          return () => {
            order.push("dispose-p2");
          };
        },
      }),
    ]);
    kernel.dispose();
    expect(order).toEqual([
      "effect-1",
      "effect-2",
      "dispose-p2",
      "dispose-p1",
      "dispose-effect-1",
    ]);
  });

  it("ctx.app：未传 Fastify 时访问抛错，传入时返回实例", () => {
    let noAppError: unknown;
    composePlugins(makeEnv(), [
      plugin("probe-no-app", {
        onApply(ctx) {
          try {
            void ctx.app;
          } catch (error) {
            noAppError = error;
          }
        },
      }),
    ]);
    expect(noAppError).toBeInstanceOf(Error);

    const app = Fastify({ logger: false });
    let seenApp: unknown;
    const kernel = composePlugins(
      makeEnv(),
      [
        plugin("probe-app", {
          onApply(ctx) {
            seenApp = ctx.app;
          },
        }),
      ],
      { app },
    );
    expect(seenApp).toBe(app);
    kernel.dispose();
  });

  it("ctx.env 即 compose 传入的 env", () => {
    const env = makeEnv({ webOrigin: "http://custom" });
    let seen: ServerEnv | undefined;
    composePlugins(env, [
      plugin("p", {
        onApply(ctx) {
          seen = ctx.env;
        },
      }),
    ]);
    expect(seen?.webOrigin).toBe("http://custom");
  });
});

describe("agent-run 事件缝（DEC-1，只 3 个事件）", () => {
  it("pre-step waterfall 按注册顺序包链，可改写 payload", async () => {
    const kernel = composePlugins(makeEnv(), [
      plugin("p", {
        onApply(ctx) {
          ctx.on("pre-step", async (payload, next) => {
            const nextPayload = await next({
              ...payload,
              input: `${String(payload.input)}-a`,
            });
            return { ...nextPayload, input: `${String(nextPayload.input)}-c` };
          });
          ctx.on("pre-step", async (payload, next) => {
            const nextPayload = await next({
              ...payload,
              input: `${String(payload.input)}-b`,
            });
            return nextPayload;
          });
        },
      }),
    ]);
    const result = await kernel.events.emitPreStep({ input: "x", runId: "r1" });
    expect(result.input).toBe("x-a-b-c");
    kernel.dispose();
  });

  it("waterfall 不调 next 即拦截后续监听器", async () => {
    const tail = vi.fn();
    const kernel = composePlugins(makeEnv(), [
      plugin("p", {
        onApply(ctx) {
          ctx.on("pre-step", async (payload) => ({
            ...payload,
            input: "intercepted",
          }));
          ctx.on("pre-step", async (payload, next) => {
            tail();
            return next(payload);
          });
        },
      }),
    ]);
    const result = await kernel.events.emitPreStep({
      input: "x",
      runId: undefined,
    });
    expect(result.input).toBe("intercepted");
    expect(tail).not.toHaveBeenCalled();
    kernel.dispose();
  });

  it("on 返回退订函数，退订后不再收到事件", async () => {
    const seen: string[] = [];
    const kernel = composePlugins(makeEnv(), [
      plugin("p", {
        onApply(ctx) {
          const unsubscribe = ctx.on("turn-stopping", async (payload, next) => {
            seen.push(payload.runId);
            await next();
          });
          unsubscribe();
        },
      }),
    ]);
    await kernel.events.emitTurnStopping({ runId: "r2" });
    expect(seen).toEqual([]);
    kernel.dispose();
  });

  it("turn-stopping serial 按注册顺序串行收尾", async () => {
    const order: string[] = [];
    const kernel = composePlugins(makeEnv(), [
      plugin("p", {
        onApply(ctx) {
          ctx.on("turn-stopping", async (_payload, next) => {
            order.push("first-start");
            await next();
            order.push("first-end");
          });
          ctx.on("turn-stopping", async (_payload, next) => {
            order.push("second");
            await next();
          });
        },
      }),
    ]);
    await kernel.events.emitTurnStopping({ runId: "r3" });
    expect(order).toEqual(["first-start", "second", "first-end"]);
    kernel.dispose();
  });

  it("tool-pre-execute deny 拒绝工具执行且不触达 execute", async () => {
    const executeSpy = vi.fn(async () => "ran");
    const kernel = composePlugins(makeEnv(), [
      plugin("p", {
        onApply(ctx) {
          ctx.get("tools").register({
            name: "demo_tool",
            description: "demo",
            scope: "code",
            parameters: { type: "object" },
            execute: executeSpy,
          });
          ctx.on("tool-pre-execute", async (payload) => ({
            ...payload,
            decision: "deny",
            denyReason: "策略禁止",
          }));
        },
      }),
    ]);
    const tools: ToolRegistry = kernel.get("tools");
    await expect(
      tools.execute("demo_tool", { k: 1 }, { runId: "r4" }),
    ).rejects.toBeInstanceOf(ToolDeniedError);
    await expect(
      tools.execute("demo_tool", { k: 1 }, { runId: "r4" }),
    ).rejects.toThrow(/策略禁止/);
    expect(executeSpy).not.toHaveBeenCalled();
    kernel.dispose();
  });

  it("tool-pre-execute allow 放行并透传 args", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const kernel = composePlugins(makeEnv(), [
      plugin("p", {
        onApply(ctx) {
          ctx.get("tools").register({
            name: "demo_tool",
            description: "demo",
            scope: "shared",
            parameters: { type: "object" },
            execute: async (args) => `ok:${JSON.stringify(args)}`,
          });
          ctx.on("tool-pre-execute", async (payload, next) => {
            seen.push(payload.args);
            return next(payload);
          });
        },
      }),
    ]);
    const tools: ToolRegistry = kernel.get("tools");
    await expect(tools.execute("demo_tool", { q: "hi" })).resolves.toBe(
      'ok:{"q":"hi"}',
    );
    expect(seen).toEqual([{ q: "hi" }]);
    kernel.dispose();
  });
});

describe("ctx.tools 注册表", () => {
  it("重名工具注册 fail loud，require 未注册 fail loud", () => {
    const kernel = composePlugins(makeEnv(), [
      plugin("tools-probe", {
        onApply(ctx) {
          const tools: ToolRegistry = ctx.get("tools");
          const def = {
            name: "dup",
            description: "",
            scope: "shared" as const,
            parameters: {},
            execute: async () => null,
          };
          tools.register(def);
          expect(() => tools.register(def)).toThrow(/工具 dup 重复注册/);
          expect(() => tools.require("ghost")).toThrow(/工具 ghost 未注册/);
        },
      }),
    ]);
    kernel.dispose();
  });

  it("list 按 scope 过滤：目标 scope + shared", () => {
    const kernel = composePlugins(makeEnv(), [
      plugin("tools-seeder", {
        onApply(ctx) {
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
      }),
    ]);
    const tools: ToolRegistry = kernel.get("tools");
    expect(
      tools
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["tool_code", "tool_design", "tool_shared"]);
    expect(
      tools
        .list("design")
        .map((t) => t.name)
        .sort(),
    ).toEqual(["tool_design", "tool_shared"]);
    expect(
      tools
        .list("code")
        .map((t) => t.name)
        .sort(),
    ).toEqual(["tool_code", "tool_shared"]);
    expect(tools.list("shared").map((t) => t.name)).toEqual(["tool_shared"]);
    kernel.dispose();
  });

  it("注册 disposer 注销工具", () => {
    const kernel = composePlugins(makeEnv(), [
      plugin("tools-probe", {
        onApply(ctx) {
          const tools: ToolRegistry = ctx.get("tools");
          const off = tools.register({
            name: "temp",
            description: "",
            scope: "shared",
            parameters: {},
            execute: async () => null,
          });
          expect(tools.get("temp")).toBeDefined();
          off();
          expect(tools.get("temp")).toBeUndefined();
        },
      }),
    ]);
    kernel.dispose();
  });
});

describe("ctx.capabilities 注册表", () => {
  it("同一 capability 多 provider、按 id 解析、重复 id fail loud", () => {
    const kernel = composePlugins(makeEnv(), [
      plugin("caps-probe", {
        onApply(ctx) {
          const caps: CapabilityRegistry = ctx.get("capabilities");
          caps.register("execution-mode", {
            id: "agent",
            value: { label: "自主循环" },
          });
          caps.register("execution-mode", {
            id: "plan",
            value: { label: "规划待批准" },
          });
          expect(caps.list<{ label: string }>("execution-mode")).toHaveLength(
            2,
          );
          expect(
            caps.get<{ label: string }>("execution-mode", "plan")?.label,
          ).toBe("规划待批准");
          expect(caps.list("ghost")).toEqual([]);
          expect(() => caps.require("execution-mode", "missing")).toThrow(
            /贡献者 missing 未注册/,
          );
          expect(() =>
            caps.register("execution-mode", { id: "agent", value: {} }),
          ).toThrow(/贡献者 agent 重复注册/);
        },
      }),
    ]);
    kernel.dispose();
  });

  it("注册 disposer 注销能力贡献者", () => {
    const kernel = composePlugins(makeEnv(), [
      plugin("caps-probe", {
        onApply(ctx) {
          const caps: CapabilityRegistry = ctx.get("capabilities");
          const off = caps.register("subagent", {
            id: "video",
            value: { n: 1 },
          });
          expect(caps.list("subagent")).toHaveLength(1);
          off();
          expect(caps.list("subagent")).toHaveLength(0);
        },
      }),
    ]);
    kernel.dispose();
  });
});
