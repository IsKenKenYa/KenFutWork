import { expect, it } from "vitest";
import { projectMcpArguments, toKernelTool } from "./mcp-tools.js";
import type { TaskMcpService } from "./task-mcp-service.js";
import { createTaskMcpTools } from "./task-mcp-tools.js";

it("Code创建/安装/卸载入口是execute，状态只读；参数投影幂等但真实env照常送达服务", async () => {
  const calls: unknown[] = [];
  const service: TaskMcpService = {
    create: async (input) => {
      calls.push(input);
      return {
        name: input.name,
        taskId: "owned",
        status: "connected",
        envKeys: Object.keys(input.env ?? {}),
        toolNames: [],
      };
    },
    install: async (input) => {
      calls.push(input);
      return {
        name: input.name,
        taskId: "owned",
        status: "connected",
        envKeys: Object.keys(input.env ?? {}),
        toolNames: [],
      };
    },
    remove: async () => {},
    list: async () => [],
    closeTask: async () => {},
    revoke: async () => {},
    shutdown: async () => {},
  };
  const tools = createTaskMcpTools(service);
  expect(tools.map((entry) => [entry.name, entry.scope, entry.access])).toEqual(
    [
      ["create_mcp_server", "code", "execute"],
      ["install_mcp_server", "code", "execute"],
      ["uninstall_mcp_server", "code", "execute"],
      ["list_mcp_servers", "code", "read"],
    ],
  );
  const creator = tools.find((entry) => entry.name === "create_mcp_server");
  if (!creator) throw new Error("缺少Code MCP创建入口。");
  const args = {
    name: "local",
    path: "server.mjs",
    env: { USER_TOKEN: "private-value" },
  };
  const projected = creator.projectArguments?.(args);
  expect(projected).toEqual({
    name: "local",
    path: "server.mjs",
    envKeys: ["USER_TOKEN"],
  });
  if (!projected) throw new Error("缺少参数事件投影。");
  expect(creator.projectArguments?.(projected)).toEqual(projected);
  expect(await creator.execute(args, {})).toMatchObject({
    envKeys: ["USER_TOKEN"],
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject(args);
  expect(args.env.USER_TOKEN).toBe("private-value");
});

it("全局Design MCP工具不再借shared进入Code；readOnlyHint不是执行权限", () => {
  const tool = toKernelTool(
    "legacy",
    { name: "lookup", inputSchema: { type: "object" } },
    { listTools: async () => ({ tools: [] }), callTool: async () => null },
  );
  expect(tool.scope).toBe("design");
  expect(tool.access).toBe("execute");
  expect(tool.readonlyExecution).not.toBe(true);
});

it("已投影的envKeys保持，真正参数对象和值不被投影修改", () => {
  const args = { command: "node", env: { TOKEN: "secret" } };
  expect(projectMcpArguments(projectMcpArguments(args))).toEqual({
    command: "node",
    envKeys: ["TOKEN"],
  });
  expect(args.env).toEqual({ TOKEN: "secret" });
});
