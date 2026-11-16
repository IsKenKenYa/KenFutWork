import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import type {
  RunToolResolutionContext,
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistry,
} from "../../kernel/types.js";
import { assertMcpContribution, mcpConfigurationVersion } from "./mcp-tools.js";
import { TaskMcpError } from "./task-mcp-context.js";

const pageSchema = z.object({ cursor: z.string().optional() }).strict();
const readSchema = z.object({ uri: z.string().min(1) }).strict();
export type McpResourceRequest =
  | ({ operation: "list" | "templates" } & z.infer<typeof pageSchema>)
  | ({ operation: "read" } & z.infer<typeof readSchema>);
export type McpResourceResult = Awaited<ReturnType<typeof requestMcpResource>>;

const catalogFields = new Set([
  "uri",
  "uriTemplate",
  "name",
  "title",
  "description",
  "mimeType",
  "size",
]);
const contentFields = new Set(["uri", "mimeType", "text", "blob"]);
const project = (value: object, fields: Set<string>) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key)));

const isModelResource = (uri: string) =>
  !uri.trimStart().toLowerCase().startsWith("ui:");

/** URI 和游标原样传给 SDK；模型结果只包含资源公开字段。 */
export async function requestMcpResource(
  client: Client,
  input: McpResourceRequest,
  options: RequestOptions,
) {
  if (!client.getServerCapabilities()?.resources)
    throw new TaskMcpError(
      "mcp_resources_unavailable",
      "此 MCP 服务不支持资源读取，请检查服务设置。",
    );
  if (input.operation === "read") {
    const result = await client.readResource({ uri: input.uri }, options);
    return {
      contents: result.contents
        .filter((content) => isModelResource(content.uri))
        .map((content) => project(content, contentFields)),
    };
  }
  const params =
    input.cursor === undefined ? undefined : { cursor: input.cursor };
  if (input.operation === "templates") {
    const result = await client.listResourceTemplates(params, options);
    return {
      resourceTemplates: result.resourceTemplates
        .filter((template) => isModelResource(template.uriTemplate))
        .map((template) => project(template, catalogFields)),
      ...(result.nextCursor === undefined
        ? {}
        : { nextCursor: result.nextCursor }),
    };
  }
  const result = await client.listResources(params, options);
  return {
    resources: result.resources
      .filter((resource) => isModelResource(resource.uri))
      .map((resource) => project(resource, catalogFields)),
    ...(result.nextCursor === undefined
      ? {}
      : { nextCursor: result.nextCursor }),
  };
}

const descriptions = {
  list: "列出资源。返回 nextCursor 时可继续分页。",
  templates: "列出资源 URI 模板。返回 nextCursor 时可继续分页。",
  read: "读取指定 URI 的资源。URI 属于该 MCP 服务，不作为本机文件路径解释。",
};

export function registerMcpResourceTools(input: {
  registry: ToolRegistry;
  sourceId: string;
  sourceName: string;
  configurationVersion: string;
  call(
    request: McpResourceRequest,
    context: ToolExecutionContext,
  ): Promise<McpResourceResult>;
  allowRun?(run: RunToolResolutionContext): boolean;
}) {
  // 名称的摘要长度属于协议标识编码，保证函数名称保持短小且不包含路径或凭据。
  const namespace = createHash("sha256")
    .update(input.sourceId)
    .digest("hex")
    .slice(0, 12);
  const disposers: Array<() => void> = [];
  const names: string[] = [];
  try {
    for (const operation of ["list", "templates", "read"] as const) {
      const id = `mcp:resources:${input.sourceId}:${operation}`;
      const schema = operation === "read" ? readSchema : pageSchema;
      const tool: ToolDefinition = {
        name: `mcp_resource__${namespace}__${operation}`,
        description: `${input.sourceName}：${descriptions[operation]}`,
        scope: "shared",
        exposure: "deferred",
        // 远端资源提供方不构成本机只读证明，沿用 MCP 的执行审批。
        access: "execute",
        parameters: z.toJSONSchema(schema),
        zodSchema: schema,
        async execute(args, context) {
          assertMcpContribution(input.registry, id, context);
          const request: McpResourceRequest =
            operation === "read"
              ? { operation, ...readSchema.parse(args) }
              : { operation, ...pageSchema.parse(args) };
          if (request.operation === "read" && !isModelResource(request.uri))
            throw new TaskMcpError(
              "mcp_resource_app_only",
              "这个资源只供插件页面使用，请在插件中打开。",
              403,
            );
          return input.call(request, context);
        },
      };
      names.push(tool.name);
      disposers.push(
        input.registry.registerDynamic({
          id,
          scope: "shared",
          configurationVersion: mcpConfigurationVersion({
            source: input.configurationVersion,
            operation,
            parameters: tool.parameters,
          }),
          resolve(run) {
            const handle = run.scopeHandle;
            if (
              !handle ||
              handle.role === "explore" ||
              handle.role === "review" ||
              handle.describe().sandboxMode === "read-only" ||
              input.allowRun?.(run) === false
            )
              return null;
            return tool;
          },
        }),
      );
    }
  } catch (error) {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    throw error;
  }
  return {
    names,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
  };
}
