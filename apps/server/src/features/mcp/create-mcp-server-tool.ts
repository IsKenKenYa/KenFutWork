import { extname } from "node:path";
import { resolveSandboxDir } from "../../agent/sandbox-dir.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import { resolveInsideRoot } from "../../utils/inside-root.js";
import type { AdminService } from "../admin/admin-service.js";
import type { RequestAuthenticator } from "../auth/types.js";
import type { McpService } from "./mcp-service.js";

/**
 * `create_mcp_server` 工具：把**工作目录里的 MCP server 脚本**注册成本实例的 MCP 工具源
 * （创造模式的第三种产物：插件 / 技能 / MCP 工具）。
 *
 * 与 `install_plugin` 同两条硬约束：
 * 1. **管理员门**：MCP server 由服务端在本机起子进程并把自己的工具注册进统一注册表，
 *    与 `/api/mcp/servers` 同一条 admin 门（非管理员如实拒绝）；
 * 2. **落点**：脚本路径必须在本轮 run 的沙箱工作目录内（`resolveInsideRoot` 防 `../`），
 *    目录由 `resolveSandboxDir` 解析——与 agent/git/插件安装同一处口径。
 *
 * 另外：`command` 缺省按扩展名推断（.py → python、.js/.mjs → node），找不到解释器时
 * 调用方可以显式传 command。注册成功后 MCP 服务会立刻连接并把 `mcp__<name>__<tool>`
 * 注册进工具表（下一次 run 即可用）。
 */
export function createCreateMcpServerTool(options: {
  service: McpService;
  auth: RequestAuthenticator;
  admin: AdminService;
  sandboxRoot?: string | undefined;
  canvasWorkDirs?: Record<string, string> | undefined;
}): ToolDefinition {
  return {
    name: "create_mcp_server",
    description:
      "把工作目录里的 MCP server 脚本注册成本实例的 MCP 工具源（需要管理员权限）。用于「创造」模式：先用 write_file 在工作目录写好 server 脚本（stdio 协议），再用本工具注册；注册成功后其工具以 mcp__<name>__<tool> 进入统一注册表，后续会话可直接调用。",
    scope: "shared",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "server 名（工具前缀 mcp__<name>__…，建议小写下划线）",
        },
        path: {
          type: "string",
          description: "相对工作目录的 server 脚本，如 mcp/py_tools.py",
        },
        command: {
          type: "string",
          description:
            "启动命令（可选，默认按扩展名推断：.py → python，.js/.mjs → node）",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "附加启动参数（脚本路径会自动作为第一个参数）",
        },
        env: {
          type: "object",
          description: "子进程环境变量（可选）",
        },
      },
      required: ["name", "path"],
    },
    execute: async (args, execCtx: ToolExecutionContext) => {
      const name = String(args.name ?? "").trim();
      const relativePath = String(args.path ?? "").trim();
      if (!name || !relativePath) {
        throw new Error("create_mcp_server 需要 name 与 path。");
      }
      if (!execCtx.canvasId) {
        throw new Error(
          "当前执行上下文缺少画布，无法定位工作目录（create_mcp_server 需要 run 绑定项目）。",
        );
      }
      const user = execCtx.accessToken
        ? await options.auth
            .authenticate({
              headers: { authorization: `Bearer ${execCtx.accessToken}` },
            })
            .catch(() => null)
        : null;
      if (!user) {
        throw new Error("当前执行上下文缺少用户凭据，无法注册 MCP server。");
      }
      try {
        await options.admin.requireAdmin(user);
      } catch {
        throw new Error(
          "注册 MCP server 需要管理员权限（会在本机起子进程并注册工具），请让管理员在模拟器设置里添加。",
        );
      }

      const sandboxDir = resolveSandboxDir(
        execCtx.canvasId,
        options.sandboxRoot,
        options.canvasWorkDirs?.[execCtx.canvasId],
      );
      const scriptPath = resolveInsideRoot(sandboxDir, relativePath);

      const explicitCommand =
        typeof args.command === "string" && args.command.trim()
          ? args.command.trim()
          : null;
      const command = explicitCommand ?? inferCommand(scriptPath);
      const extraArgs = Array.isArray(args.args)
        ? (args.args as unknown[]).map((item) => String(item))
        : [];
      const env =
        args.env && typeof args.env === "object"
          ? Object.fromEntries(
              Object.entries(args.env as Record<string, unknown>).map(
                ([key, value]) => [key, String(value)],
              ),
            )
          : undefined;

      const created = await options.service.create({
        name,
        command,
        args: [scriptPath, ...extraArgs],
        env: env ?? {},
        // 注册即启用：创造模式的产物应当马上可用（面板里可随时停用）
        enabled: true,
      });

      return {
        registered: true,
        name: created.name,
        command,
        script: scriptPath,
        hint: "MCP server 已注册并尝试连接：连接状态与工具数可在「MCP」面板查看；工具以 mcp__<name>__<tool> 命名，后续会话可直接调用。",
      };
    },
  };
}

/** 按扩展名推断启动命令（显式 command 优先）。 */
function inferCommand(scriptPath: string): string {
  const extension = extname(scriptPath).toLowerCase();
  if (extension === ".py") return "python";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return "node";
  }
  return scriptPath;
}
