import { z } from "zod";
import type { ToolDefinition } from "../../kernel/types.js";
import { projectMcpArguments } from "./mcp-tools.js";
import {
  taskMcpCreateSchema,
  taskMcpInstallSchema,
} from "./task-mcp-context.js";
import type { TaskMcpService } from "./task-mcp-service.js";

function definition(
  name: string,
  description: string,
  schema: z.ZodType,
  access: "read" | "execute",
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    name,
    description,
    scope: "code",
    exposure: "deferred",
    access,
    parameters: z.toJSONSchema(schema),
    zodSchema: schema,
    projectArguments: projectMcpArguments,
    execute,
  };
}

export function createTaskMcpTools(service: TaskMcpService): ToolDefinition[] {
  const nameSchema = z.object({ name: z.string().trim().min(1) }).strict();
  return [
    definition(
      "create_mcp_server",
      "把当前Task授权目录里的stdio MCP脚本安装为本Task工具源。自动推断.py/python、.js/node；进程经ProcessSandbox，env只能显式提供，不继承服务端供应商凭证。连接跨Run保留，工具用ToolSearch发现；改配置前先卸载。",
      taskMcpCreateSchema,
      "execute",
      (args, context) =>
        service.create(taskMcpCreateSchema.parse(args), context),
    ),
    definition(
      "install_mcp_server",
      "把显式command/args/env的stdio MCP服务安装到当前Task。command是单个可执行程序，args是精确argv；不借用全局MCP或管理员env。进程与工具绑定Task，实际调用仍需要当前审批。",
      taskMcpInstallSchema,
      "execute",
      (args, context) =>
        service.install(taskMcpInstallSchema.parse(args), context),
    ),
    definition(
      "uninstall_mcp_server",
      "卸载当前Task的MCP连接并等待进程范围确认退出。主代理可管理本Task所有连接，子代理只能卸载自己安装的连接。",
      nameSchema,
      "execute",
      async (args, context) => {
        await service.remove(nameSchema.parse(args).name, context);
        return { uninstalled: true };
      },
    ),
    definition(
      "list_mcp_servers",
      "列出当前Task的MCP连接状态、工具名称与env键名；不回显env值。全局Design MCP仍在原管理面板维护。",
      z.object({}).strict(),
      "read",
      (_args, context) => service.list(context),
    ),
  ];
}
