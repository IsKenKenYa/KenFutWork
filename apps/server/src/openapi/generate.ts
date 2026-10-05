// OpenAPI 3.1 生成器：读中央路由表（registry.ts）+ shared zod 契约，产出 docs/api/openapi.json。
// 运行：`pnpm api:spec`（根 script 委托到 server 包，经 tsx 执行）。
// 纪律：
// 1. info.title 固定不变——Apifox 按它匹配导入模块，变更会导致重导入时新建重复模块。
// 2. 契约 schema 直接引用 @kenfutwork/shared 实例，经 z.toJSONSchema 转 JSON Schema，
//    具名 schema 进 components.schemas（$ref），派生 schema（.pick 等）内联。
// 3. 产物入库且 diff 必须稳定：schema 按名称排序、paths 按路由表顺序、两空格缩进。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as sharedContracts from "@kenfutwork/shared";
import {
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import { z } from "zod";
import { OPENAPI_ROUTES, type OpenApiRouteEntry } from "./registry.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT_PATH = resolve(rootDir, "docs/api/openapi.json");

const SPEC_TITLE = "KenFutWork Community API";

// 域 → 中文目录名（x-apifox-folder，Apifox 导入时的目录树）与中文说明。
// 封闭清单的对账裁判在 tests/api-spec-consistency.test.mjs 的 CLOSED_TAGS，两处同改。
const TAG_META: Record<string, { folder: string; description: string }> = {
  instance: {
    folder: "本地实例",
    description: "本机实例身份、数据位置及受控生命周期。",
  },
  "local-access": {
    folder: "本机接入",
    description: "一次性连接入口、HttpOnly会话与脚本授权。",
  },
  blobs: {
    folder: "对象存储",
    description: "本地 blob 对象读取，非公开桶需 HMAC 签名。",
  },
  "brand-kits": {
    folder: "品牌套件",
    description: "品牌套件（logo、图片资产）的增删改查与文件上传。",
  },
  canvases: {
    folder: "画布",
    description: "Design 模式画布内容的读取与整体保存。",
  },
  chat: {
    folder: "会话与消息",
    description: "画布下的聊天会话与消息列表管理。",
  },
  code: {
    folder: "代码模式",
    description:
      "Code 模式工作目录能力：git（状态/暂存/提交/工作树/分支）、文件浏览、终端、检查点与索引。",
  },
  "execution-modes": {
    folder: "执行模式",
    description: "线程级执行模式（六档）的查询与切换。",
  },
  flow: {
    folder: "Flow 集成",
    description: "Flow宿主状态与未来连接边界；本期未接通的身份交换明确不可用。",
  },
  fonts: {
    folder: "字体",
    description: "授权本机字体检索与缓存。",
  },
  generate: {
    folder: "同步生成",
    description: "图像同步生成与视频生成任务受理（BYOK 通道）。",
  },
  health: { folder: "健康检查", description: "服务健康探针（免鉴权）。" },
  "image-proxy": {
    folder: "图片代理",
    description: "白名单域名外部图片代理拉取，绕过浏览器 CORS。",
  },
  jobs: {
    folder: "后台任务",
    description: "图片/视频生成后台任务的创建、查询与取消。",
  },
  mcp: {
    folder: "MCP 服务器",
    description: "MCP server 配置管理（已授权本机客户端管理）与注册表检索。",
  },
  models: {
    folder: "模型",
    description: "对话/图像/视频模型清单与动态模型目录。",
  },
  permissions: {
    folder: "权限",
    description: "权限档位、自动化档位与人工放行授权。",
  },
  plugins: {
    folder: "插件",
    description:
      "第三方插件安装/卸载/启停（已授权本机客户端管理）、预检与自定义路由派发。",
  },
  projects: {
    folder: "项目",
    description: "design/code/flow 三类项目的增删改查与缩略图上传。",
  },
  "provider-instances": {
    folder: "供应商实例",
    description:
      "本地BYOK配置与CAS；已授权设置可按需读取Key，模型目录不包含Key。",
  },
  runs: {
    folder: "智能体运行",
    description: "智能体 run 的创建、取消、子代理清单与工作区活动统计。",
  },
  settings: {
    folder: "本地设置",
    description: "实例设置（含默认模型）的读取与更新。",
  },
  skills: {
    folder: "技能",
    description:
      "技能目录、自定义技能增删改、URL/工作目录/市场三路导入与工作区安装态。",
  },
  system: {
    folder: "系统能力",
    description: "原生目录选择器等桌面能力探针与调用。",
  },
  uploads: {
    folder: "资产上传",
    description: "项目图片资产上传、签名 URL 与删除。",
  },
  usage: { folder: "用量", description: "工作区用量汇总与使用统计。" },
};

function isZodSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

// 具名契约 → 组件名映射：以 shared 包的导出变量名为组件名。
function buildSchemaNameMap(): Map<z.ZodType, string> {
  const map = new Map<z.ZodType, string>();
  for (const [name, value] of Object.entries(sharedContracts)) {
    if (isZodSchema(value) && !map.has(value)) map.set(value, name);
  }
  return map;
}

// /api/projects/:projectId/thumbnail → getProjectsByProjectIdThumbnail
// 构造规则保证唯一：method+path 在 Fastify 里本就唯一，path 段到驼峰段的映射是单射。
function buildOperationId(method: string, fastifyPath: string): string {
  const segments = fastifyPath
    .split("/")
    .filter((segment) => segment !== "" && segment !== "api");
  const tail = segments
    .map((segment) => {
      if (segment.startsWith(":")) return `By${pascalCase(segment.slice(1))}`;
      if (segment === "*") return "Wildcard";
      return pascalCase(segment);
    })
    .join("");
  return `${method}${tail}`;
}

function pascalCase(input: string): string {
  return input
    .replace(/[-_]/g, "-")
    .split("-")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join("");
}

function toJson(schema: z.ZodType, io: "input" | "output") {
  return z.toJSONSchema(schema, { io, target: "draft-2020-12" });
}

interface Ctx {
  schemaNames: Map<z.ZodType, string>;
  components: { name: string; json: object }[];
}

/** 只机械分解原快照；共享契约原件不变，每份模型小于导入平台的单模型限制。 */
function codeUiSnapshotComponents() {
  const registry = z.registry<{ id: string }>();
  const schemas = {
    codeUiSnapshotResponseSchema: sharedContracts.codeUiSnapshotResponseSchema,
    "zcodeUiProtocol.conversationSnapshotSchema":
      sharedContracts.zcodeUiProtocol.conversationSnapshotSchema,
    "zcodeUiProtocol.conversationRowSchema":
      sharedContracts.zcodeUiProtocol.conversationRowSchema,
    "zcodeUiProtocol.toolCallRowSchema":
      sharedContracts.zcodeUiProtocol.toolCallRowSchema,
  };
  for (const [id, schema] of Object.entries(schemas))
    registry.add(schema, { id });
  const converted = z.toJSONSchema(registry, {
    io: "output",
    target: "draft-2020-12",
    uri: (id) => `#/components/schemas/${id}`,
  });
  return Object.entries(converted.schemas).map(([name, json]) => {
    // component $ref 以完整文档为基准；移除 converter 生成的 fragment-only $id。
    const { $id: _id, ...schema } = json;
    return { name, json: schema };
  });
}

// 优先 $ref 具名组件；派生 schema（.pick / z.object 包装）内联。
function schemaRefOrInline(
  ctx: Ctx,
  schema: z.ZodType,
  io: "input" | "output",
): object {
  const name = ctx.schemaNames.get(schema);
  if (!name) return toJson(schema, io);
  if (
    name === "codeUiSnapshotResponseSchema" &&
    !ctx.components.some((entry) => entry.name === name)
  ) {
    ctx.components.push(...codeUiSnapshotComponents());
  }
  if (!ctx.components.some((entry) => entry.name === name)) {
    ctx.components.push({ name, json: toJson(schema, io) });
  }
  return { $ref: `#/components/schemas/${name}` };
}

function jsonContent(schema: object, mediaType = "application/json") {
  return { [mediaType]: { schema } };
}

function pathParameters(openApiPath: string): object[] {
  return [...openApiPath.matchAll(/\{(\w+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string" },
    description: "路径参数",
  }));
}

function queryParameters(schema: z.ZodType): object[] {
  const json = toJson(schema, "input") as {
    properties?: Record<string, object>;
    required?: string[];
  };
  const properties = json.properties ?? {};
  const required = new Set(json.required ?? []);
  return Object.entries(properties).map(([name, propSchema]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: propSchema,
  }));
}

function buildOperation(ctx: Ctx, entry: OpenApiRouteEntry) {
  const openApiPath = entry.path.replace(/:(\w+)/g, "{$1}");
  const operationId = buildOperationId(entry.method, entry.path);

  const parameters = [
    ...pathParameters(openApiPath),
    ...(entry.querySchema ? queryParameters(entry.querySchema) : []),
  ];

  let requestBody: object | undefined;
  if (entry.multipart) {
    const properties: Record<string, object> = {
      [entry.multipart.fileField]: { type: "string", format: "binary" },
    };
    for (const [field, description] of Object.entries(
      entry.multipart.fields ?? {},
    )) {
      properties[field] = { type: "string", description };
    }
    requestBody = {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            required: [entry.multipart.fileField],
            properties,
          },
        },
      },
    };
  } else if (entry.requestSchema) {
    requestBody = {
      required: true,
      content: jsonContent(
        schemaRefOrInline(ctx, entry.requestSchema, "input"),
      ),
    };
  }

  const responses: Record<string, object> = {};
  if (entry.successStatus === 204) {
    responses["204"] = { description: "成功，无响应体" };
  } else if (entry.binaryResponse) {
    responses[String(entry.successStatus)] = {
      description: "成功",
      content: {
        [entry.binaryResponse]: {
          schema: { type: "string", format: "binary" },
        },
      },
    };
  } else {
    responses[String(entry.successStatus)] = {
      description:
        entry.successStatus === 201
          ? "创建成功"
          : entry.successStatus === 202
            ? "已受理（异步执行）"
            : "成功",
      ...(entry.responseSchema
        ? {
            content: jsonContent(
              schemaRefOrInline(ctx, entry.responseSchema, "output"),
              entry.responseMediaType,
            ),
          }
        : {}),
    };
  }
  if (entry.auth === "local") {
    responses["401"] = {
      description: "未认证或令牌无效",
      content: jsonContent(
        schemaRefOrInline(ctx, unauthenticatedErrorResponseSchema, "output"),
      ),
    };
  }
  responses.default = {
    description: "业务错误（错误码为封闭枚举，见 ApplicationError 契约）",
    content: jsonContent(
      schemaRefOrInline(ctx, applicationErrorResponseSchema, "output"),
    ),
  };

  return {
    openApiPath,
    operation: {
      operationId,
      summary: entry.summary,
      description: entry.description,
      tags: [entry.tag],
      security:
        entry.auth === "public"
          ? []
          : entry.auth === "local"
            ? [{ localCookie: [] }, { bearerAuth: [] }]
            : [{ bearerAuth: [] }],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses,
    },
  };
}

export function buildOpenApiSpec() {
  const ctx: Ctx = { schemaNames: buildSchemaNameMap(), components: [] };

  const paths: Record<string, Record<string, object>> = {};
  const operationIds = new Set<string>();
  for (const entry of OPENAPI_ROUTES) {
    const { openApiPath, operation } = buildOperation(ctx, entry);
    if (operationIds.has(operation.operationId)) {
      throw new Error(
        `operationId 冲突：${operation.operationId}（${entry.method} ${entry.path}）`,
      );
    }
    operationIds.add(operation.operationId);
    let pathItem = paths[openApiPath];
    if (!pathItem) {
      pathItem = {};
      paths[openApiPath] = pathItem;
    }
    pathItem[entry.method] = operation;
  }

  const tags = Object.entries(TAG_META).map(([name, meta]) => ({
    name,
    description: meta.description,
    "x-apifox-folder": meta.folder,
  }));

  const schemas: Record<string, object> = {};
  for (const { name, json } of ctx.components.sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    schemas[name] = json;
  }

  const spec = {
    openapi: "3.1.0",
    info: {
      title: SPEC_TITLE,
      version: "1.0.0",
      description:
        "KenFutWork 本地 BYOK 实例 HTTP API。浏览器通过一次性入口建立 HttpOnly cookie；脚本使用明确授权的 Bearer 凭据；不依赖官方账户或订阅。此规范由共享契约与中央路由表生成，勿手改。",
    },
    servers: [
      { url: "http://localhost:3001", description: "本地开发（dev 默认端口）" },
    ],
    tags,
    security: [{ localCookie: [] }, { bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        localCookie: {
          type: "apiKey",
          in: "cookie",
          name: "kfw_local_access",
          description: "由一次性本机连接票据兑换的HttpOnly会话。",
        },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "明确授权的本机脚本或桌面启动凭据；Flow服务间端点使用独立共享密钥。",
        },
      },
      schemas,
    },
  };
  return { spec, count: operationIds.size };
}

function main() {
  const { spec, count } = buildOpenApiSpec();
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(spec, null, 2)}\n`);
  console.log(
    `已生成 ${OUT_PATH}（${count} 个端点，${Object.keys(spec.components.schemas).length} 个契约组件）`,
  );
}

main();
