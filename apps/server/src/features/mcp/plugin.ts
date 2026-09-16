import type { ServerEnv } from "../../config/env.js";
import { registerMcpRoutes } from "../../http/mcp.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createCreateMcpServerTool } from "./create-mcp-server-tool.js";
import { createMcpService, type McpService } from "./mcp-service.js";
import { createMcpServerStore } from "./server-store.js";

/**
 * mcp 插件（P4d，§4.5）：连接 MCP server → 工具注册进 ctx.tools。
 *
 * 配置来源两处（**同名时库内优先**）：
 * - `mcp_servers` 表：界面可增删改（变更类走管理员门，因为会在本机起子进程）；
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
  if (!raw || !raw.trim()) {
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

  return {
    name: "mcp",
    inject: ["auth", "admin", "persistence"],
    apply(ctx) {
      service = createMcpService({
        env: ctx.env as ServerEnv,
        registry: ctx.get("tools"),
        store: createMcpServerStore(ctx.get("persistence")),
      });
      ctx.effect(() => () => {
        void service?.shutdown();
      });
      // 连接是异步的：挂载后逐个连接并注册工具（可用性不影响进程启动）
      // 兜底 catch：即使 connectAll 内部失效，也不能把进程带走（unhandled rejection）
      void service.connectAll().catch((error: unknown) => {
        console.warn(
          "[mcp] 启动连接异常（不影响进程）：",
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    mounted(ctx) {
      if (!service) {
        throw new Error("[mcp] service 未初始化（apply 未执行）。");
      }
      // 创造模式的第三种产物：把工作目录里的 MCP server 脚本注册成本实例的工具源。
      // 注册放 mounted（不是 apply）：apply 期 ctx.get 只解析得到「更早 apply 的插件」的
      // key，admin 依赖会因顺序而 fail loud（probe 装配实测踩中）。
      ctx.get("tools").register(
        createCreateMcpServerTool({
          service,
          auth: ctx.get("auth"),
          admin: ctx.get("admin"),
          sandboxRoot: ctx.env.sandboxRoot,
          canvasWorkDirs: ctx.env.canvasWorkDirs,
        }),
      );
      void registerMcpRoutes(ctx.app, {
        admin: ctx.get("admin"),
        auth: ctx.get("auth"),
        service,
      });
    },
  };
}
