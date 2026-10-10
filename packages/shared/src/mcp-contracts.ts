import {
  JSONRPCErrorResponseSchema,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zcodeMcpListParamsSchema } from "@zcode/shared";
import { z } from "zod";
import { runIdSchema } from "./contracts.js";
import { applicationErrorResponseSchema } from "./http.js";

/** 原用户层读取只承接UI上下文；本机MCP由实例持有，不建立Project或Task。 */
export const codeUiMcpSettingsLoadRequestSchema = z
  .object({
    workspacePath: z.string().optional(),
  })
  .strict();
export const codeUiMcpSettingsReadRequestSchema = z
  .object({ hostRecordId: z.uuid() })
  .strict();
export const codeUiMcpStatusRequestSchema =
  codeUiMcpSettingsLoadRequestSchema.extend({
    workspaceIdentity: z.string().optional(),
    mode: zcodeMcpListParamsSchema.shape.mode,
    mcpServers: zcodeMcpListParamsSchema.shape.mcpServers,
  });

/** 标准MCP wire直接采用官方SDK契约；不另造工具、Task或身份DTO。 */
export const computerUseMcpMessageSchema = JSONRPCMessageSchema;
export const computerUseMcpQuerySchema = z.object({ runId: runIdSchema });
export const computerUseSnapshotQuerySchema = z.object({
  taskId: z.uuid(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
/** SDK HTTP层的解析/会话错误用null id；标准MCP消息的RequestId仍保持原SDK约束。 */
export const computerUseMcpTransportErrorSchema =
  JSONRPCErrorResponseSchema.extend({
    id: JSONRPCErrorResponseSchema.shape.id.nullable(),
  });
export const computerUseMcpErrorResponseSchema = z.union([
  computerUseMcpTransportErrorSchema,
  applicationErrorResponseSchema,
]);
export const computerUseMcpEventStreamSchema = z
  .string()
  .describe("标准MCP Streamable HTTP的SSE消息流；每个data帧是原JSON-RPC消息。");

/**
 * MCP server 管理契约（`/api/mcp/servers*`）。
 *
 * 密钥纪律：请求可携带 `env` 与 HTTP `headers`（含值），响应只回 `envKeys` / `headerKeys`。
 * 授权设置经原宿主按稳定记录 ID 读取凭据；目录、工具参数和事件不携带值。
 */

export const mcpServerSourceSchema = z.enum(["env", "managed"]);
export type McpServerSource = z.infer<typeof mcpServerSourceSchema>;

export const mcpServerStatusSchema = z.enum(["connected", "error", "disabled"]);
export type McpServerStatusValue = z.infer<typeof mcpServerStatusSchema>;

export const mcpServerKindSchema = z.enum(["stdio", "http"]);
export type McpServerKind = z.infer<typeof mcpServerKindSchema>;

export const mcpServerViewSchema = z.object({
  /** 库内配置才有 id；来源为 env 的条目为 null（只读）。 */
  id: z.string().nullable(),
  name: z.string().min(1),
  source: mcpServerSourceSchema,
  enabled: z.boolean(),
  status: mcpServerStatusSchema,
  /** 传输类型：stdio = 本地子进程（command/args），http = 远程端点（url）。 */
  kind: mcpServerKindSchema.default("stdio"),
  /** http 类型的远程端点 URL。 */
  url: z.string().nullable(),
  command: z.string(),
  args: z.array(z.string()),
  /** 仅键名，值不外发。 */
  envKeys: z.array(z.string()),
  /** http 类型的自定义请求头，同样**只回键名**（如 Authorization）。 */
  headerKeys: z.array(z.string()),
  toolCount: z.number(),
  error: z.string().nullable(),
});
export type McpServerView = z.infer<typeof mcpServerViewSchema>;

export const mcpServerListResponseSchema = z.object({
  servers: z.array(mcpServerViewSchema),
});
export type McpServerListResponse = z.infer<typeof mcpServerListResponseSchema>;

const mcpEnvSchema = z.record(z.string(), z.string());

/**
 * http 类型的自定义请求头（HA 的 `POST /api/mcp` 一类端点靠 `Authorization` 鉴权）。
 *
 * 名按 HTTP token 收窄（Authorization / X-Api-Key 这类，不放任任意字节），值禁 CR/LF
 * ——拼进 `requestInit.headers` 前必须先挡住头注入。值等同密钥：普通目录仅下发键名。
 */
const mcpHeadersSchema = z.record(
  z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/, "请求头名只允许字母数字与 -"),
  z
    .string()
    .max(4096)
    .refine((value) => !/[\r\n]/.test(value), "请求头值不能含换行"),
);

export const mcpServerCreateRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/, "名称只允许字母数字与 - _"),
    kind: mcpServerKindSchema.default("stdio"),
    /** stdio：本地可执行命令。http：远程端点 URL（http/https）。 */
    command: z.string().trim().max(500).optional(),
    /** http 类型的远程端点 URL。 */
    url: z.string().trim().max(500).optional(),
    args: z.array(z.string().max(500)).max(50).default([]),
    env: mcpEnvSchema.default({}),
    /** http 类型的自定义请求头（值只写不读）。 */
    headers: mcpHeadersSchema.default({}),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "stdio" && !value.command?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "stdio 类型必须提供本地命令",
      });
    }
    if (value.kind === "stdio" && Object.keys(value.headers).length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["headers"],
        message: "stdio 类型用 env 传密钥，不支持自定义请求头",
      });
    }
    if (value.kind === "http") {
      if (value.command?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["command"],
          message: "http 类型不需要本地命令（用 url 表示远程端点）",
        });
      }
      const url = value.url?.trim();
      if (!url || !/^https?:\/\//.test(url)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: "http 类型必须提供 http(s) 远程端点 URL",
        });
      }
    }
  });
export type McpServerCreateRequest = z.infer<
  typeof mcpServerCreateRequestSchema
>;

export const mcpServerUpdateRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "名称只允许字母数字与 - _")
    .optional(),
  command: z.string().trim().min(1).max(500).optional(),
  /** http 类型的远程端点 URL（编辑 http 行时改它；kind 本身不支持就地切换）。 */
  url: z.string().trim().min(1).max(500).optional(),
  args: z.array(z.string().max(500)).max(50).optional(),
  env: mcpEnvSchema.optional(),
  /** http 类型的自定义请求头（提供时整体替换；值只写不读）。 */
  headers: mcpHeadersSchema.optional(),
  enabled: z.boolean().optional(),
});
export type McpServerUpdateRequest = z.infer<
  typeof mcpServerUpdateRequestSchema
>;

/** 原配置表单的本机宿主写边界；原件不另建文件配置或安装数据。 */
export const codeUiMcpSettingsSaveRequestSchema = z
  .object({
    action: z.enum(["upsert", "delete", "set-enabled"]),
    source: z.literal("zcodeagentmcp"),
    name: mcpServerCreateRequestSchema.shape.name,
    hostRecordId: z.uuid().nullable(),
    projectPath: z.string().optional(),
    location: z.unknown().optional(),
    enabled: z.boolean().optional(),
    config: z
      .object({
        type: z.enum(["stdio", "http"]).optional(),
        command: z.string().optional(),
        url: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: mcpEnvSchema.optional(),
        enable: z.boolean().optional(),
        headers: mcpHeadersSchema.optional(),
        oauth: z.unknown().optional(),
        timeoutMs: z.number().optional(),
        protocolVersion: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const mcpServerResponseSchema = z.object({
  server: mcpServerViewSchema,
});
export type McpServerResponse = z.infer<typeof mcpServerResponseSchema>;

// === 精选目录与官方注册表（MCP 市场） ===

export const mcpCuratedParamSchema = z.object({
  key: z.string(),
  label: z.string(),
  example: z.string(),
  required: z.boolean(),
});

export const mcpCuratedServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  command: z.string(),
  argsTemplate: z.array(z.string()),
  params: z.array(mcpCuratedParamSchema),
  envKeys: z.array(z.string()).optional(),
  requires: z.enum(["node", "python"]),
  homepage: z.string().optional(),
});
export type McpCuratedServer = z.infer<typeof mcpCuratedServerSchema>;

export const mcpCuratedListResponseSchema = z.object({
  servers: z.array(mcpCuratedServerSchema),
});
export type McpCuratedListResponse = z.infer<
  typeof mcpCuratedListResponseSchema
>;

export const mcpRegistryServerSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  repositoryUrl: z.string().nullable(),
  packages: z.array(
    z.object({
      registryType: z.string(),
      identifier: z.string(),
      version: z.string().optional(),
      transportType: z.string().optional(),
      runtimeHint: z.string().optional(),
    }),
  ),
  remotes: z.array(z.object({ type: z.string(), url: z.string().optional() })),
  /** 建议的接入类型：http = 远程端点（suggestedUrl），stdio = 本地包（suggestedCommand）。 */
  kind: mcpServerKindSchema.default("stdio"),
  installable: z.boolean(),
  unsupportedReason: z.string().nullable(),
  suggestedCommand: z.string().nullable(),
  suggestedArgs: z.array(z.string()),
  /** http 类型的建议端点 URL（stdio 为 null）。 */
  suggestedUrl: z.string().nullable(),
  suggestedName: z.string(),
  isLatest: z.boolean(),
});
export type McpRegistryServer = z.infer<typeof mcpRegistryServerSchema>;

export const mcpRegistrySearchResponseSchema = z.object({
  servers: z.array(mcpRegistryServerSchema),
  count: z.number(),
  nextCursor: z.string().nullable(),
});
export type McpRegistrySearchResponse = z.infer<
  typeof mcpRegistrySearchResponseSchema
>;
