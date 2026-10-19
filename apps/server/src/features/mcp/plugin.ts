import type { ServerEnv } from "../../config/env.js";
import { registerMcpRoutes } from "../../http/mcp.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { CODE_UI_HOST_RPC_CAPABILITY } from "../code-ui/host-rpc-handler.js";
import type { ComputerUseMcpSource } from "../computer-use/mcp-backend.js";
import { createCodeUiMcpHost } from "./code-ui-host.js";
import { createMcpService, type McpService } from "./mcp-service.js";
import { mcpConfigurationVersion } from "./mcp-tools.js";
import { createMcpServerStore } from "./server-store.js";
import {
  createTaskMcpService,
  type TaskMcpService,
} from "./task-mcp-service.js";
import { createTaskMcpTools } from "./task-mcp-tools.js";

/**
 * mcp 插件（P4d，§4.5）：连接 MCP server → 工具注册进 ctx.tools。
 *
 * 配置来源两处（**同名时库内优先**）：
 * - `mcp_servers` 表：界面可增删改（变更类走已授权本机访问门，因为会在本机起子进程）；
 * - `KENFUTWORK_MCP_SERVERS` 环境变量：引导/遗留入口，UI 标注来源且只读。
 *
 * 插件**常驻挂载**（不再以「有没有配 server」决定 enabled）——否则没配环境变量时
 * 连管理入口都不存在。连接失败是运行态（状态里可查原因），不阻断进程启动。
 */

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw?.trim()) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      "[mcp] KENFUTWORK_MCP_SERVERS 必须是 JSON 数组（fail loud）。",
    );
  }
  return parsed.map((entry) => {
    const config = entry as Partial<McpServerConfig>;
    if (!config.name || !config.command) {
      throw new Error(
        "[mcp] KENFUTWORK_MCP_SERVERS 每项需要 name 与 command（fail loud）。",
      );
    }
    return {
      name: config.name,
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
    };
  });
}

export function createMcpPlugin(): PluginDefinition {
  // 同一个 service 实例贯穿 apply（连接）与 mounted（路由）：
  // 两处各建一个实例会让路由拿到空连接表——状态恒为 error、重连会开出第二条连接
  let service: McpService | undefined;
  let tasks: TaskMcpService | undefined;

  return {
    name: "mcp",
    inject: [
      "localInstance",
      "localAccess",
      "persistence",
      "processSandbox",
      "settings",
      "executionScopes",
      "taskWork",
    ],
    apply(ctx) {
      service = createMcpService({
        env: ctx.env as ServerEnv,
        registry: ctx.get("tools"),
        store: createMcpServerStore(
          ctx.get("persistence"),
          ctx.get("localInstance"),
        ),
        resolveTimeoutMs: async () => {
          const actor = await ctx.get("localInstance").serviceActor();
          return (
            await ctx
              .get("settings")
              .getInstanceSettings(actor, actor.instanceId)
          ).executeTimeoutMs;
        },
        executeTool: async (source, tool, args, context, remoteCall) => {
          if (!tasks) throw new Error("MCP Task工作域未加载，请重启应用。");
          return source.kind === "stdio"
            ? tasks.callConfigured(source, tool, args, context)
            : remoteCall();
        },
        onDisconnect: (name) => tasks?.closeSource(name) ?? Promise.resolve(),
      });
    },
    mounted(ctx) {
      if (!service) {
        throw new Error("[mcp] service 未初始化（apply 未执行）。");
      }
      for (const [id, value] of Object.entries(
        createCodeUiMcpHost({
          service,
          localInstance: ctx.get("localInstance"),
        }),
      )) {
        ctx.effect(() =>
          ctx
            .get("capabilities")
            .register(CODE_UI_HOST_RPC_CAPABILITY, { id, value }),
        );
      }
      // 两种工作方式都通过固定Task目录与同一沙箱创建MCP工具源。
      // 注册放 mounted（不是 apply）：apply 期 ctx.get 只解析得到「更早 apply 的插件」的
      // key，后装配的能力依赖会因顺序而 fail loud（probe 装配实测踩中）。
      const tools = ctx.get("tools");
      const taskService = createTaskMcpService({
        sandbox: ctx.get("processSandbox"),
        registry: tools,
        settings: ctx.get("settings"),
        version: ctx.env.version,
      });
      tasks = taskService;
      ctx.effect(() =>
        ctx
          .get("capabilities")
          .register<ComputerUseMcpSource>("computer-use-mcp-source", {
            id: "mcp:instance-inventory",
            value: {
              list: async (context) => {
                if (
                  !context.actor ||
                  context.actor.instanceId !== context.instanceId
                )
                  throw new Error("桌面MCP缺少可信本地调用上下文");
                await ctx.get("localInstance").resolve(context.actor);
                return [
                  ...(await service!.computerUseConnections()),
                  ...(await taskService.computerUseConnections(context)),
                ];
              },
            },
          }),
      );
      for (const tool of createTaskMcpTools(taskService)) {
        ctx.effect(() =>
          tools.registerDynamic({
            id: `mcp:${tool.name}`,
            scope: "shared",
            configurationVersion: mcpConfigurationVersion({
              version: ctx.env.version,
              parameters: tool.parameters,
              access: tool.access,
              execute: tool.execute.toString(),
            }),
            resolve(run) {
              const handle = run.scopeHandle;
              if (!handle) return null;
              if (
                tool.access !== "read" &&
                (handle.role === "explore" ||
                  handle.role === "review" ||
                  handle.describe().sandboxMode === "read-only")
              )
                return null;
              return tool;
            },
          }),
        );
      }
      ctx.effect(() =>
        ctx.get("capabilities").register("task-before-process-close", {
          id: "mcp:task-connections",
          value: {
            close: (instanceId: string, taskId: string) =>
              taskService.closeTask(instanceId, taskId, "Task已关闭"),
          },
        }),
      );
      ctx.effect(() =>
        ctx
          .get("executionScopes")
          .onRevoke(({ previous, next }) => taskService.revoke(previous, next)),
      );
      ctx.effect(() =>
        ctx
          .get("taskWork")
          .onHostLost(() => taskService.shutdown("执行宿主租约已失效")),
      );
      const shutdown = async () => {
        await taskService.shutdown("MCP插件/宿主关闭");
        await service?.shutdown();
      };
      ctx.app.addHook("onClose", shutdown);
      void service.connectAll().catch((error: unknown) => {
        console.warn(
          "[mcp] 启动连接异常：",
          error instanceof Error ? error.message : String(error),
        );
      });
      void registerMcpRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        localInstance: ctx.get("localInstance"),
        service,
      });
      // 最后登记：LIFO卸载先夹紧准入并join真实stop，再撤销工具和生命周期订阅。
      ctx.effect(() => shutdown);
    },
  };
}
