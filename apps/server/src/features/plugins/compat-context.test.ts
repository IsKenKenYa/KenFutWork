import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { CompatLoadError, loadCompatPlugin } from "./compat-context.js";

/**
 * 运行时适配层测试：**真实 kernel 工具注册表** + dsh 形状插件模块，
 * 验证「装进来的 dsh 插件真能注册出可调用工具」这条主链路。
 */

function makeEnv(): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "test-model",
    port: 0,
    version: "test",
    webOrigin: "http://localhost:3000",
  } as ServerEnv;
}

function makeHost() {
  const kernel = composePlugins(makeEnv(), []);
  return {
    tools: kernel.get("tools"),
    subscribe: () => () => {},
    promptFragments: () => () => {},
    routes: () => () => {},
    ui: () => () => {},
    label: "demo",
  };
}

/** 一个典型的 dsh 工具插件模块（与 dsh mcp-client 的注册写法同形）。 */
function demoModule(overrides: Record<string, unknown> = {}) {
  return {
    name: "dsh-demo-plugin",
    inject: ["tools"],
    apply(ctx: {
      effect: (fn: () => unknown) => void;
      tools: { register: (def: unknown) => unknown };
    }) {
      ctx.effect(() =>
        ctx.tools.register({
          name: "demo_echo",
          description: "回显输入",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          execute: async (args: { text?: string }) => ({
            content: [{ type: "text", text: `echo:${args.text ?? ""}` }],
          }),
        }),
      );
    },
    ...overrides,
  };
}

describe("compat-context：正常装载", () => {
  it("dsh 形状插件注册的工具进入内核注册表并可执行", async () => {
    const host = makeHost();
    const loaded = await loadCompatPlugin(demoModule(), host);

    expect(loaded.pluginName).toBe("dsh-demo-plugin");
    expect(loaded.toolNames).toEqual(["demo_echo"]);

    const tool = host.tools.require("demo_echo");
    expect(tool.scope).toBe("shared");
    expect(tool.description).toBe("回显输入");

    const result = await tool.execute({ text: "hi" }, {});
    expect(result).toBe("echo:hi");

    loaded.dispose();
    expect(host.tools.get("demo_echo")).toBeUndefined();
  });

  it("structuredContent 优先于文本块", async () => {
    const host = makeHost();
    const loaded = await loadCompatPlugin(
      demoModule({
        apply(ctx: {
          effect: (fn: () => unknown) => void;
          tools: { register: (d: unknown) => unknown };
        }) {
          ctx.effect(() =>
            ctx.tools.register({
              name: "demo_structured",
              execute: async () => ({
                content: [{ type: "text", text: "ignored" }],
                structuredContent: { answer: 42 },
              }),
            }),
          );
        },
      }),
      host,
    );
    const result = await host.tools.require("demo_structured").execute({}, {});
    expect(result).toEqual({ answer: 42 });
    loaded.dispose();
  });

  it("isError 结果转为抛错（运行时据此标记失败）", async () => {
    const host = makeHost();
    const loaded = await loadCompatPlugin(
      demoModule({
        apply(ctx: {
          effect: (fn: () => unknown) => void;
          tools: { register: (d: unknown) => unknown };
        }) {
          ctx.effect(() =>
            ctx.tools.register({
              name: "demo_fail",
              execute: async () => ({
                isError: true,
                content: [{ type: "text", text: "上游拒绝" }],
              }),
            }),
          );
        },
      }),
      host,
    );
    await expect(
      host.tools.require("demo_fail").execute({}, {}),
    ).rejects.toThrow("上游拒绝");
    loaded.dispose();
  });

  it("effect 返回的 disposer 在卸载时执行（且副作用只执行一次）", async () => {
    const host = makeHost();
    let effectRuns = 0;
    let disposed = 0;
    const loaded = await loadCompatPlugin(
      demoModule({
        apply(ctx: {
          effect: (fn: () => unknown) => void;
          tools: { register: (d: unknown) => unknown };
        }) {
          ctx.effect(() => {
            effectRuns += 1;
            ctx.tools.register({ name: "demo_once", execute: async () => 1 });
            return () => {
              disposed += 1;
            };
          });
        },
      }),
      host,
    );
    expect(effectRuns).toBe(1);
    loaded.dispose();
    expect(disposed).toBe(1);
    expect(host.tools.get("demo_once")).toBeUndefined();
  });

  it("ctx.inject 支持的能力直接执行回调", async () => {
    const host = makeHost();
    let called = 0;
    const loaded = await loadCompatPlugin(
      demoModule({
        apply(ctx: {
          effect: (fn: () => unknown) => void;
          tools: { register: () => unknown };
          inject: (caps: string[], fn: () => void) => void;
        }) {
          ctx.inject(["tools"], () => {
            called += 1;
          });
        },
      }),
      host,
    );
    expect(called).toBe(1);
    loaded.dispose();
  });

  it("async apply 被 await（dsh 插件常在 apply 内 await 连接）", async () => {
    const host = makeHost();
    let settled = false;
    await loadCompatPlugin(
      demoModule({
        async apply(ctx: {
          effect: (fn: () => unknown) => void;
          tools: { register: (d: unknown) => unknown };
        }) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          ctx.effect(() =>
            ctx.tools.register({
              name: "demo_late",
              execute: async () => "ok",
            }),
          );
          settled = true;
        },
      }),
      host,
    );
    expect(settled).toBe(true);
    expect(host.tools.get("demo_late")).toBeDefined();
  });
});

describe("compat-context：拒绝路径", () => {
  it("模块未导出 apply", async () => {
    const host = makeHost();
    await expect(loadCompatPlugin({ name: "x" }, host)).rejects.toThrow(
      CompatLoadError,
    );
    await expect(loadCompatPlugin({ name: "x" }, host)).rejects.toMatchObject({
      reason: "not_a_plugin",
    });
  });

  it("运行时声明未支持的能力：二次校验拦截", async () => {
    const host = makeHost();
    await expect(
      loadCompatPlugin(demoModule({ inject: ["llm"] }), host),
    ).rejects.toMatchObject({ reason: "capability_unsupported" });
  });

  it("ctx.inject 请求未支持能力被拦截", async () => {
    const host = makeHost();
    await expect(
      loadCompatPlugin(
        demoModule({
          apply(ctx: {
            effect: (fn: () => unknown) => void;
            tools: { register: () => unknown };
            inject: (caps: string[], fn: () => void) => void;
          }) {
            ctx.inject(["sessions"], () => {});
          },
        }),
        host,
      ),
    ).rejects.toMatchObject({ reason: "capability_unsupported" });
  });

  it("订阅未派发事件被拦截", async () => {
    const host = makeHost();
    await expect(
      loadCompatPlugin(
        demoModule({
          apply(ctx: {
            effect: (fn: () => unknown) => void;
            tools: { register: () => unknown };
            on: (event: string, listener: () => void) => void;
          }) {
            ctx.on("fs/changed", () => {});
          },
        }),
        host,
      ),
    ).rejects.toMatchObject({ reason: "event_unsupported" });
  });

  it("工具定义缺 execute 被拦截", async () => {
    const host = makeHost();
    await expect(
      loadCompatPlugin(
        demoModule({
          apply(ctx: {
            effect: (fn: () => unknown) => void;
            tools: { register: (d: unknown) => unknown };
          }) {
            ctx.effect(() => ctx.tools.register({ name: "demo_bad" }));
          },
        }),
        host,
      ),
    ).rejects.toMatchObject({ reason: "tool_invalid" });
  });

  it("工具名冲突（内核 fail loud）透传为 apply 失败", async () => {
    const host = makeHost();
    const duplicate = demoModule();
    const first = await loadCompatPlugin(duplicate, host);
    await expect(loadCompatPlugin(duplicate, host)).rejects.toThrow(
      CompatLoadError,
    );
    first.dispose();
  });

  it("apply 抛错被包装为 apply_failed 并保留原因", async () => {
    const host = makeHost();
    await expect(
      loadCompatPlugin(
        demoModule({
          apply() {
            throw new Error("boom");
          },
        }),
        host,
      ),
    ).rejects.toMatchObject({ reason: "apply_failed" });
  });

  it("apply 抛错后回滚：不留残留工具（否则成为无人能卸载的孤儿）", async () => {
    const host = makeHost();
    await expect(
      loadCompatPlugin(
        demoModule({
          apply(ctx: {
            effect: (fn: () => unknown) => void;
            tools: { register: (d: unknown) => unknown };
          }) {
            ctx.effect(() =>
              ctx.tools.register({ name: "demo_leak", execute: async () => 1 }),
            );
            throw new Error("boom");
          },
        }),
        host,
      ),
    ).rejects.toThrow();
    expect(host.tools.get("demo_leak")).toBeUndefined();
  });

  it("工具名冲突失败后，先前实例的注册不被误伤", async () => {
    const host = makeHost();
    const first = await loadCompatPlugin(
      demoModule({
        apply(ctx: {
          effect: (fn: () => unknown) => void;
          tools: { register: (d: unknown) => unknown };
        }) {
          ctx.effect(() =>
            ctx.tools.register({
              name: "demo_keep",
              execute: async () => "ok",
            }),
          );
        },
      }),
      host,
    );
    await expect(
      loadCompatPlugin(
        demoModule({
          apply(ctx: {
            effect: (fn: () => unknown) => void;
            tools: { register: (d: unknown) => unknown };
          }) {
            ctx.effect(() =>
              ctx.tools.register({
                name: "demo_keep",
                execute: async () => "dup",
              }),
            );
          },
        }),
        host,
      ),
    ).rejects.toThrow();
    expect(host.tools.require("demo_keep")).toBeDefined();
    expect(await host.tools.require("demo_keep").execute({}, {})).toBe("ok");
    first.dispose();
  });
});
