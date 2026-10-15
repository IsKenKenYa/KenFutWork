import { expect, it, vi } from "vitest";
import { mcpConfigurationVersion } from "../features/mcp/mcp-tools.js";
import { AgentRunEventBus, ToolRegistryImpl } from "./context.js";
import type { RunToolResolutionContext, ToolDefinition } from "./types.js";

function definition(
  name: string,
  scope: ToolDefinition["scope"] = "shared",
): ToolDefinition {
  return {
    name,
    scope,
    description: "test contribution",
    parameters: { type: "object", properties: { value: { type: "string" } } },
    access: "read",
    configurationVersion: "1",
    execute: async () => "original",
  };
}
const resolution = (
  preset: "code" | "design" = "code",
): RunToolResolutionContext => ({
  preset,
  backendFactory: (() => ({})) as never,
});

it("MCP配置与工具schema嵌套重排后仍可恢复冻结能力，参数数组改变则拒绝", () => {
  const original = definition("Reordered");
  original.configurationVersion = mcpConfigurationVersion({
    env: { TOKEN: "test-secret", OPTIONAL: undefined },
    args: ["server.mjs"],
    command: "node",
  });
  const first = new ToolRegistryImpl(new AgentRunEventBus());
  first.register(original);
  const frozenContributions = first.captureContributions("code");
  const restarted = new ToolRegistryImpl(new AgentRunEventBus());
  const dispose = restarted.register({
    ...original,
    parameters: { properties: { value: { type: "string" } }, type: "object" },
    configurationVersion: mcpConfigurationVersion({
      command: "node",
      args: ["server.mjs"],
      env: { TOKEN: "test-secret" },
    }),
  });
  expect(
    restarted
      .resolveRunTools({ ...resolution(), frozenContributions })
      .map((tool) => tool.name),
  ).toEqual(["Reordered"]);
  dispose();
  restarted.register({
    ...original,
    configurationVersion: mcpConfigurationVersion({
      command: "node",
      args: ["--changed", "server.mjs"],
      env: { TOKEN: "test-secret" },
    }),
  });
  expect(
    restarted.resolveRunTools({ ...resolution(), frozenContributions }),
  ).toEqual([]);
});

it("接纳后的新工具不进入当前Run目录，直接执行也不能借用旧能力快照", async () => {
  const registry = new ToolRegistryImpl(new AgentRunEventBus());
  registry.register(definition("Shared"));
  const frozenContributions = registry.captureContributions("code");
  const added = definition("InstalledAfterAdmission");
  added.execute = vi.fn(async () => "must not execute");
  registry.register(added);
  expect(
    registry
      .resolveRunTools({ ...resolution(), frozenContributions })
      .map((tool) => tool.name),
  ).toEqual(["Shared"]);
  await expect(
    registry.executeDefinition(added, {}, { frozenContributions }),
  ).rejects.toThrow(/接纳能力/);
  expect(added.execute).not.toHaveBeenCalled();
});

it("删除和替换贡献不让旧定义或新实现复用原Run权限", async () => {
  const registry = new ToolRegistryImpl(new AgentRunEventBus());
  const original = definition("Original");
  const dispose = registry.register(original);
  const frozenContributions = registry.captureContributions("code");
  const exposed = registry.resolveRunTools({
    ...resolution(),
    frozenContributions,
  })[0]!;
  dispose();
  expect(
    registry.resolveRunTools({ ...resolution(), frozenContributions }),
  ).toEqual([]);
  await expect(
    registry.executeDefinition(exposed, {}, { frozenContributions }),
  ).rejects.toThrow(/注册|schema/);
  const replacement = {
    ...original,
    execute: vi.fn(async () => "different behavior"),
  };
  registry.register(replacement);
  expect(
    registry.resolveRunTools({ ...resolution(), frozenContributions }),
  ).toEqual([]);
  await expect(
    registry.executeDefinition(replacement, {}, { frozenContributions }),
  ).rejects.toThrow(/接纳能力/);
  expect(replacement.execute).not.toHaveBeenCalled();
});

it("同版本重建签名稳定，Code与Design共享贡献一致且模式私有贡献互相过滤", () => {
  const register = () => {
    const registry = new ToolRegistryImpl(new AgentRunEventBus());
    registry.register(definition("Shared"));
    registry.registerDynamic({
      id: "Code",
      scope: "code",
      configurationVersion: "1",
      resolve: () => definition("Code", "code"),
    });
    registry.registerDynamic({
      id: "Design",
      scope: "design",
      configurationVersion: "1",
      resolve: () => definition("Design", "design"),
    });
    return registry;
  };
  const first = register();
  const code = first.captureContributions("code");
  const design = first.captureContributions("design");
  expect(code.entries.map((entry) => entry.id)).toEqual(["Code", "Shared"]);
  expect(design.entries.map((entry) => entry.id)).toEqual(["Design", "Shared"]);
  expect(code.entries.find((entry) => entry.id === "Shared")).toEqual(
    design.entries.find((entry) => entry.id === "Shared"),
  );
  const restarted = register();
  expect(restarted.captureContributions("code")).toEqual(code);
  expect(
    restarted
      .resolveRunTools({ ...resolution(), frozenContributions: code })
      .map((entry) => entry.name),
  ).toEqual(["Shared", "Code"]);
  expect(() =>
    restarted.resolveRunTools({
      ...resolution("design"),
      frozenContributions: code,
    }),
  ).toThrow(/快照与工作方式/);
});

it("声明配置版本的动态工厂在版本改变后失效，即使工厂源码相同", () => {
  const registry = new ToolRegistryImpl(new AgentRunEventBus());
  const factory = {
    id: "Configured",
    scope: "shared" as const,
    configurationVersion: "1",
    resolve: () => definition("Configured"),
  };
  const dispose = registry.registerDynamic(factory);
  const frozenContributions = registry.captureContributions("code");
  dispose();
  registry.registerDynamic({ ...factory, configurationVersion: "2" });
  expect(
    registry.resolveRunTools({ ...resolution(), frozenContributions }),
  ).toEqual([]);
});
