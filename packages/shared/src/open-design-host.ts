import { z } from "zod";

/**
 * OpenDesign 宿主适配层契约。
 *
 * 定位：OpenDesign（写代码 / 原型用的设计引擎，Figma 同类位）被本仓当**右侧栏画布**嵌进来时，
 * 走的是宿主适配层——面板形态、入口门控、探活与（后续的）身份 / 导航缝。本文件只定义**宿主侧**
 * （本仓）与工作台之间的形状；OpenDesign 侧是另一份实现（跨仓库不共享代码）。
 *
 * 与 flow（`ff-embed/v1`）的差别：OpenDesign **不是模式**，只占 Code 模式右侧栏、与浏览器面板
 * 同位互斥（`AGENTS.md` 产品行为不变量：Code 主区恒为对话）。因此这里没有模式切换相关形状，
 * 只有「入口该不该出现」与「面板嵌哪个地址」。
 */

/**
 * OpenDesign 插件（`plugins/open-design`，产品入口）的 bundle 名。
 * 工作台以「该插件已安装」+「宿主适配层已就绪」共同门控右侧栏入口；
 * 名字两端（市场清单 / 前端门控）只有这一处权威。
 */
export const OPEN_DESIGN_PLUGIN_BUNDLE_NAME = "kenfutwork-open-design";

/**
 * OpenDesign 宿主能力探针（`GET /api/open-design/host/status`，宿主自己的前端调用，
 * 本机接入验证）。
 *
 * 与 flow 的 status 只比配置不同：OpenDesign 的承载是**独立服务**（自托管栈 /
 * 桌面 sidecar），配了地址不等于服务活着，所以这里带一次真实可达性探测。
 * 未就绪时缺什么写进 `reasons`，界面如实透出（fail loud，不放无提示的假开关）。
 */
export const openDesignHostStatusResponseSchema = z.object({
  /** 配置齐备**且**服务可达时为 true。 */
  enabled: z.boolean(),
  /** OpenDesign 前端地址（`KENFUTWORK_OPEN_DESIGN_FRONTEND_URL`）；未配置为 null。 */
  frontendUrl: z.string().nullable(),
  /** 未启用时缺什么 / 哪里不通（每条一句可读原因）；启用后为空数组。 */
  reasons: z.array(z.string()),
});
export type OpenDesignHostStatusResponse = z.infer<
  typeof openDesignHostStatusResponseSchema
>;

/**
 * 右侧栏入口门控（纯逻辑，接线在各端宿主 hook）。
 *
 * 入口纪律（`AGENTS.md` 不变量）：OpenDesign 以插件形态交付，
 * **未安装插件或宿主适配层未就绪时不出现入口**——不摆空壳、不放假开关。
 */
export type OpenDesignEntry =
  | { available: true; frontendUrl: string }
  | { available: false; reason: string };

export function resolveOpenDesignEntry(input: {
  /** OpenDesign 插件（`kenfutwork-open-design`）是否已安装。 */
  pluginInstalled: boolean;
  pluginEnabled: boolean;
  /** 宿主适配层状态；null = 探针请求失败（按不可用处理，不猜）。 */
  status: OpenDesignHostStatusResponse | null;
}): OpenDesignEntry {
  if (!input.pluginInstalled) {
    return {
      available: false,
      reason: "未安装 OpenDesign 插件（插件市场可安装）。",
    };
  }
  if (!input.pluginEnabled)
    return { available: false, reason: "OpenDesign 插件已停用。" };
  if (!input.status) {
    return {
      available: false,
      reason:
        "无法获取 OpenDesign 宿主状态（/api/open-design/host/status 不可达）。",
    };
  }
  if (!input.status.enabled || !input.status.frontendUrl) {
    return {
      available: false,
      reason: input.status.reasons.length
        ? `OpenDesign 未就绪：${input.status.reasons.join(" ")}`
        : "OpenDesign 未就绪。",
    };
  }
  return { available: true, frontendUrl: input.status.frontendUrl };
}

/* ------------------------------------------------------------------ *
 * 桌面承载配置（§205 闭环：设置页写入口）
 *
 * 桌面形态的 OpenDesign 承载走 `<dataDir>/config/open-design.env`（Tauri 启动时
 * 白名单注入，改文件重启生效）。这对缝给设置页读写：GET 回文件值 + 是否待重启；
 * PUT 全量替换两键（空值 = 清除）。明文回显按 DEC-7 本地凭据口径（可查看/复制）。
 * ------------------------------------------------------------------ */

/** GET 响应：文件里的当前配置 + 生效判定。 */
export const openDesignHostConfigResponseSchema = z.object({
  /** 文件值（未配置为 null）。 */
  frontendUrl: z.string().nullable(),
  embedSecret: z.string().nullable(),
  /** 文件与运行中进程的实际生效值不一致 → 需要重启桌面才生效。 */
  restartRequired: z.boolean(),
  /** 生效来源：env 覆盖（dev/自托管）优先于桌面配置文件。 */
  source: z.enum(["env", "file", "none"]),
});
export type OpenDesignHostConfigResponse = z.infer<
  typeof openDesignHostConfigResponseSchema
>;

/** PUT 请求：两键全量替换；null/缺省 = 清除该键。 */
export const openDesignHostConfigUpdateSchema = z.object({
  frontendUrl: z.string().trim().min(1).max(2048).nullable().optional(),
  embedSecret: z.string().trim().min(1).max(256).nullable().optional(),
});
export type OpenDesignHostConfigUpdate = z.infer<
  typeof openDesignHostConfigUpdateSchema
>;

/* ------------------------------------------------------------------ *
 * 画布数据面（宿主代理；面板不直连 daemon）
 *
 * 面板 iframe 只吃 daemon 的**公开预览地址**（`/api/projects/:id/preview/<token>/<file>`，
 * 纯文件、无应用外壳）。其余读写——新建画布、读项目与文件、解析预览地址、取设计文本——
 * 一律经宿主路由：浏览器直连 daemon 会撞 CORS（预检 403），且宿主是唯一能顺带维护
 * 「最近画布」槽位（agent 上下文）的地方。
 * ------------------------------------------------------------------ */

/** 新建设计请求：缺省名由宿主给（「未命名设计」）。 */
export const openDesignHostCreateCanvasRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});
export type OpenDesignHostCreateCanvasRequest = z.infer<
  typeof openDesignHostCreateCanvasRequestSchema
>;

/**
 * 画布（= 上游一个 project）概要：面板拿它当标签标题与预览目标。
 * `entryFile` 是画布要展示的文件（上游 artifactManifest.entry 优先，退第一个 html）。
 */
export const openDesignHostCanvasResponseSchema = z.object({
  project: z.object({
    projectId: z.string().min(1),
    name: z.string(),
    /** 绑定的设计体系（上游 project.designSystemId；未绑定为 null）。 */
    designSystemId: z.string().nullable().optional(),
  }),
  entryFile: z.string().nullable(),
  files: z
    .array(
      z.object({
        name: z.string().min(1),
        kind: z.string(),
      }),
    )
    .max(500),
});
export type OpenDesignHostCanvasResponse = z.infer<
  typeof openDesignHostCanvasResponseSchema
>;

/**
 * 预览地址（`GET /api/open-design/host/preview-url`）：原样透出上游三件事——
 * 相对 URL（宿主 origin 拼接后进 iframe src）、iframe sandbox 取值、是否不透明 origin。
 * `expiresAt` 由上游给；过期应重取而不是继续吃 403。
 */
export const openDesignHostPreviewUrlResponseSchema = z.object({
  url: z.string().min(1),
  iframeSandbox: z.string(),
  opaqueOrigin: z.boolean(),
});
export type OpenDesignHostPreviewUrlResponse = z.infer<
  typeof openDesignHostPreviewUrlResponseSchema
>;

/** 版本历史列表：上游每个文件的历史版本元数据（只读）。 */
export const openDesignHostVersionsResponseSchema = z.object({
  versions: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string(),
        version: z.number().int(),
        createdAt: z.number(),
        size: z.number(),
        current: z.boolean(),
      }),
    )
    .max(200),
});
export type OpenDesignHostVersionsResponse = z.infer<
  typeof openDesignHostVersionsResponseSchema
>;

/** 历史版本的正文（只读预览；与设计文本同口径的大小上限）。 */
export const openDesignHostVersionContentResponseSchema = z.object({
  version: z.object({
    id: z.string().min(1),
    label: z.string(),
    version: z.number().int(),
    createdAt: z.number(),
  }),
  text: z.string(),
});
export type OpenDesignHostVersionContentResponse = z.infer<
  typeof openDesignHostVersionContentResponseSchema
>;

/** 设计文件文本（截图光栅化输入；只读，宿主侧有大小上限）。 */
export const openDesignHostFileTextResponseSchema = z.object({
  name: z.string().min(1),
  text: z.string(),
});
export type OpenDesignHostFileTextResponse = z.infer<
  typeof openDesignHostFileTextResponseSchema
>;

/** 设计文件正文大小上限（读写同一口径；超限如实报错，不静默截断）。 */
export const OPEN_DESIGN_HOST_TEXT_MAX_LENGTH = 2 * 1024 * 1024;

/**
 * 引擎就绪探针：上游可达 ≠ 能出画布。没有可用 agent CLI 时面板要说清是哪一层。
 */
export const openDesignHostReadinessResponseSchema = z.object({
  reachable: z.boolean(),
  agentAvailable: z.boolean(),
  agentId: z.string().nullable(),
  onboardingCompleted: z.boolean(),
});
export type OpenDesignHostReadinessResponse = z.infer<
  typeof openDesignHostReadinessResponseSchema
>;

/** 「最近画布」槽位（桌面数据目录里的一个文件）；一个都没有时为 null。 */
export const openDesignHostLastProjectResponseSchema = z.object({
  project: z
    .object({
      projectId: z.string().min(1),
      name: z.string(),
    })
    .nullable(),
});
export type OpenDesignHostLastProjectResponse = z.infer<
  typeof openDesignHostLastProjectResponseSchema
>;

/** 显式「配置设计引擎」的结果：done=false 时 reason 说明卡在哪。 */
export const openDesignHostProvisionResponseSchema = z.object({
  done: z.boolean(),
  agentId: z.string().nullable(),
  reason: z.string().nullish(),
});
export type OpenDesignHostProvisionResponse = z.infer<
  typeof openDesignHostProvisionResponseSchema
>;

/**
 * 按当前 KenFutWork 项目取/建绑定设计项目。
 *
 * `workspaceKey` 是项目身份（workspaceIdentity 优先，退目录路径）；宿主只存哈希，
 * 不把目录路径写进配置文件。换项目即换资源页；项目删除后再次打开会重建。
 */
export const openDesignHostWorkspaceProjectRequestSchema = z.object({
  workspaceKey: z.string().trim().min(1).max(512),
  /** 设计项目名（= 当前项目名）；缺省「未命名设计」。 */
  name: z.string().trim().min(1).max(120).optional(),
});
export type OpenDesignHostWorkspaceProjectRequest = z.infer<
  typeof openDesignHostWorkspaceProjectRequestSchema
>;

export const openDesignHostWorkspaceProjectResponseSchema =
  openDesignHostCanvasResponseSchema.extend({
    /** true = 本次新建并写入绑定；false = 复用已有绑定。 */
    created: z.boolean(),
  });
export type OpenDesignHostWorkspaceProjectResponse = z.infer<
  typeof openDesignHostWorkspaceProjectResponseSchema
>;

/** 项目资源列表（面板「+」的「打开画布」项）：上游 project 概要，按更新时间倒序。 */
export const openDesignHostProjectsResponseSchema = z.object({
  projects: z
    .array(
      z.object({
        projectId: z.string().min(1),
        name: z.string(),
        updatedAt: z.number(),
      }),
    )
    .max(200),
});
export type OpenDesignHostProjectsResponse = z.infer<
  typeof openDesignHostProjectsResponseSchema
>;

/**
 * 写入画布文件（可视化编辑保存、上传资源）。
 *
 * HTML 写入由宿主代上游记一个 `manual` 版本——编辑历史与生成历史进同一条
 * 「历史记录」，不分两套账。`encoding: "base64"` 给二进制资源（图片）。
 */
export const openDesignHostWriteFileRequestSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(240),
  content: z.string().max(OPEN_DESIGN_HOST_TEXT_MAX_LENGTH),
  encoding: z.enum(["utf8", "base64"]).optional(),
  versionLabel: z.string().trim().min(1).max(120).optional(),
});
export type OpenDesignHostWriteFileRequest = z.infer<
  typeof openDesignHostWriteFileRequestSchema
>;

export const openDesignHostWriteFileResponseSchema = z.object({
  file: z.object({ name: z.string().min(1), kind: z.string() }),
  version: z
    .object({
      id: z.string().min(1),
      version: z.number().int(),
      label: z.string(),
    })
    .nullable(),
});
export type OpenDesignHostWriteFileResponse = z.infer<
  typeof openDesignHostWriteFileResponseSchema
>;

/** 重命名设计/文档文件（读旧正文 → 写新名 → 删旧文件；仅文本设计/文档）。 */
export const openDesignHostRenameFileRequestSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(240),
  newName: z.string().min(1).max(240),
});
export type OpenDesignHostRenameFileRequest = z.infer<
  typeof openDesignHostRenameFileRequestSchema
>;

export const openDesignHostRenameFileResponseSchema = z.object({
  file: z.object({ name: z.string().min(1), kind: z.string() }),
});
export type OpenDesignHostRenameFileResponse = z.infer<
  typeof openDesignHostRenameFileResponseSchema
>;

/**
 * 宿主适配层协议版本：凭证缝（`POST /api/open-design/host/credentials`）的版本协商口径。
 * （原 `od/v1` iframe 握手随面板改嵌上游预览路由而移除——那条消息协议上游从未实现。）
 */
export const OPEN_DESIGN_EMBED_PROTOCOL_VERSION = "v1";

/* ------------------------------------------------------------------ *
 * 凭证下发（O3 / `OD-4`：BYOK 接入）
 *
 * `POST /api/open-design/host/credentials`（OpenDesign daemon → 宿主，共享密钥门）：
 * OpenDesign 驱动 coding-agent CLI 的 Key 由本仓 BYOK 实例下发。
 *
 * 与 flow credentials 缝（`flowHostCredentials*`）的差别：flow 是「一个 dify-engine
 * 实例」的单发；OpenDesign 支持 **25+ coding-agent CLI**（DeepSeek Harness 一等原生），
 * daemon 侧按各 CLI 的需要自己挑——所以宿主给**全量启用且有 Key 的实例清单**。
 *
 * 红线（与 flow 同口径）：响应里的明文 `apiKey` 是这条缝的**目的**（机器对机器、
 * 服务端到服务端，持有共享密钥的 daemon 才拿得到）；浏览器 iframe 永远不经过它，
 * 日志同样不落明文。
 * ------------------------------------------------------------------ */

/** 凭证请求：只有协议版本（与 od/v1 同一版本常量；缺省按当前版本受理）。 */
export const openDesignHostCredentialsRequestSchema = z.object({
  protocolVersion: z.string().min(1).max(16).optional(),
});

/** 单条凭证：实例身份 + 协议 + Key（明文，仅本缝）。 */
export const openDesignHostCredentialEntrySchema = z.object({
  /** 供应商实例 id（`providerInstanceResponseSchema.id` 同口径）。 */
  providerId: z.string().min(1).max(64),
  /** 实例显示名（daemon 侧按它给 CLI 做标签）。 */
  name: z.string().min(1).max(64),
  /** 实例协议（`providerProtocolSchema` 的取值；宿主侧原样透出，不在此收敛联合）。 */
  protocol: z.string().min(1).max(64),
  /** 实例 http(s) 基址；未配置（CLI 用官方默认端点）为 null。 */
  apiBase: z
    .string()
    .url()
    // 只收 http(s)：`z.url()` 放行 file:// 等其它 scheme，API 基址必须显式收敛
    .refine((value) => /^https?:\/\//u.test(value), {
      message: "apiBase 必须是 http(s) 地址",
    })
    .nullable(),
  /** BYOK Key 明文。 */
  apiKey: z.string().min(1).max(512),
});

export const openDesignHostCredentialsResponseSchema = z.object({
  /** 受理的协议版本（回显，便于 daemon 侧核对）。 */
  protocolVersion: z.string().min(1).max(16),
  /** 启用且有 Key 的实例凭证；上限 64 条（单用户本机远够，防无界载荷）。 */
  credentials: z.array(openDesignHostCredentialEntrySchema).max(64),
});
export type OpenDesignHostCredentialsRequest = z.infer<
  typeof openDesignHostCredentialsRequestSchema
>;
export type OpenDesignHostCredentialEntry = z.infer<
  typeof openDesignHostCredentialEntrySchema
>;
export type OpenDesignHostCredentialsResponse = z.infer<
  typeof openDesignHostCredentialsResponseSchema
>;

/* ------------------------------------------------------------------
 * 「我们 → 引擎」上下文同步（PR-1）：引擎读上下文的官方入口是项目内的
 * document.md（spec/工作文档）。同步把本仓的评论与标注聚合进 document.md 的
 * 受管段（成对注释标记包裹，整段替换、段外内容不动），标注笔迹另渲染成
 * PNG 落项目 review/ 目录并在受管段里引用——引擎生成时即“看得见”评审。
 * ------------------------------------------------------------------ */

/** 受管段标记：document.md 里归宿主管的区块边界（出现即归管，格式稳定不演进）。 */
export const OPEN_DESIGN_SYNC_SECTION_SPEC = "kfw-sync:spec" as const;
export const OPEN_DESIGN_SYNC_SECTION_REVIEW = "kfw-sync:review" as const;
/** 浏览器页面同步段（PR-4）：URL + 截图引用追加进 document.md。 */
export const OPEN_DESIGN_SYNC_SECTION_BROWSER = "kfw-sync:browser" as const;

export const openDesignHostSyncContextRequestSchema = z.object({
  projectId: z.string().min(1),
  /** 可选计划/规格文档（MD 正文）；有则整体替换 spec 受管段。 */
  specMarkdown: z.string().max(OPEN_DESIGN_HOST_TEXT_MAX_LENGTH).optional(),
});
export type OpenDesignHostSyncContextRequest = z.infer<
  typeof openDesignHostSyncContextRequestSchema
>;

export const openDesignHostSyncContextResponseSchema = z.object({
  document: z.object({ name: z.string().min(1) }),
  /** 本次写入的受管段（spec / review），缺项表示该段本次未写。 */
  sections: z.array(z.enum(["spec", "review"])).max(2),
  comments: z.number().int().min(0),
  annotations: z.number().int().min(0),
  /** 标注渲染出的 PNG 文件（相对项目根，如 review/annotations-….png）。 */
  annotationFiles: z.array(z.string().min(1)).max(64),
});
export type OpenDesignHostSyncContextResponse = z.infer<
  typeof openDesignHostSyncContextResponseSchema
>;

/**
 * 新建文档画布（空态「新建文档」）：建项目并写入 document.md 起始稿
 * （含 spec/review 两个受管段骨架）。响应同画布概要——面板据此开标签。
 */
export const openDesignHostCreateDocumentRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});
export type OpenDesignHostCreateDocumentRequest = z.infer<
  typeof openDesignHostCreateDocumentRequestSchema
>;

/** 在已绑定的设计项目里新建 Markdown 文档（资源页「新建文档」）。 */
export const openDesignHostCreateDesignDocumentRequestSchema = z.object({
  projectId: z.string().min(1).max(120),
  name: z.string().trim().min(1).max(120).optional(),
});
export type OpenDesignHostCreateDesignDocumentRequest = z.infer<
  typeof openDesignHostCreateDesignDocumentRequestSchema
>;

export const openDesignHostCreateDesignDocumentResponseSchema = z.object({
  file: z.object({
    name: z.string().min(1),
    kind: z.string(),
  }),
});
export type OpenDesignHostCreateDesignDocumentResponse = z.infer<
  typeof openDesignHostCreateDesignDocumentResponseSchema
>;

/** 设计体系概要（上游 /api/design-systems 的宿主代理面）。 */
export const openDesignHostDesignSystemSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().nullable(),
  summary: z.string().nullable(),
  swatches: z.array(z.string().min(1)).max(24),
});
export type OpenDesignHostDesignSystemSummary = z.infer<
  typeof openDesignHostDesignSystemSummarySchema
>;

export const openDesignHostDesignSystemsResponseSchema = z.object({
  designSystems: z.array(openDesignHostDesignSystemSummarySchema).max(500),
});
export type OpenDesignHostDesignSystemsResponse = z.infer<
  typeof openDesignHostDesignSystemsResponseSchema
>;

/**
 * 新建设计体系（代理上游 POST /api/brands 的提取链路）。
 *
 * 与上游 `/design-systems/create` 同口径：从网站或 DESIGN.md 提取颜色、字体与
 * 组件，生成一份可直接使用的已发布体系；标题由来源内容决定，不单独填名称。
 */
export const openDesignHostStartDesignSystemExtractionRequestSchema = z
  .object({
    url: z.string().trim().max(2048).optional(),
    description: z.string().trim().max(4000).optional(),
    designMd: z.string().max(200_000).optional(),
  })
  .refine((value) => Boolean(value.url?.trim() || value.designMd?.trim()), {
    message: "至少提供网站或 DESIGN.md。",
    path: ["url"],
  });
export type OpenDesignHostStartDesignSystemExtractionRequest = z.infer<
  typeof openDesignHostStartDesignSystemExtractionRequestSchema
>;

/** 提取任务快照（上游 brand 的 meta + brand 标题）。 */
export const openDesignHostDesignSystemExtractionSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  designSystemId: z.string().min(1).nullable(),
  title: z.string().min(1).nullable(),
  error: z.string().min(1).nullable(),
});
export type OpenDesignHostDesignSystemExtraction = z.infer<
  typeof openDesignHostDesignSystemExtractionSchema
>;

export const openDesignHostStartDesignSystemExtractionResponseSchema = z.object(
  {
    extraction: openDesignHostDesignSystemExtractionSchema,
  },
);
export type OpenDesignHostStartDesignSystemExtractionResponse = z.infer<
  typeof openDesignHostStartDesignSystemExtractionResponseSchema
>;

export const openDesignHostDesignSystemExtractionResponseSchema = z.object({
  extraction: openDesignHostDesignSystemExtractionSchema,
});
export type OpenDesignHostDesignSystemExtractionResponse = z.infer<
  typeof openDesignHostDesignSystemExtractionResponseSchema
>;

/** 绑定/切换画布的设计体系（代理上游 PATCH /api/projects/:id 的 designSystemId）。 */
export const openDesignHostBindDesignSystemRequestSchema = z.object({
  projectId: z.string().min(1),
  designSystemId: z.string().min(1).max(120),
});
export type OpenDesignHostBindDesignSystemRequest = z.infer<
  typeof openDesignHostBindDesignSystemRequestSchema
>;

/* ------------------------------------------------------------------
 * 静态分享 = 上游部署面（Cloudflare Pages / Vercel，用户自带 token 的静态部署）。
 * 用户口径：分享要像原来的分享功能一样**静态部署**（发布在线链接 / 自托管），
 * 不是复制面板的 localhost 链接。宿主只做代理与契约收口——真正的上传与域名
 * 由 daemon 的 deploy 路由执行（`/api/deploy/config`、`/api/projects/:id/deploy`）。
 * ------------------------------------------------------------------ */

export const openDesignDeployProviderSchema = z.enum([
  "cloudflare-pages",
  "vercel-self",
]);
export type OpenDesignDeployProvider = z.infer<
  typeof openDesignDeployProviderSchema
>;

/** 托管商配置（GET/PUT 共用；token 只回显掩码，写入时掩码原样回传=保留原值）。 */
export const openDesignHostDeployConfigSchema = z.object({
  providerId: openDesignDeployProviderSchema,
  configured: z.boolean(),
  tokenMask: z.string(),
  teamId: z.string().optional(),
  teamSlug: z.string().optional(),
  accountId: z.string().optional(),
  target: z.string().optional(),
});
export type OpenDesignHostDeployConfig = z.infer<
  typeof openDesignHostDeployConfigSchema
>;

export const openDesignHostDeployConfigUpdateSchema = z.object({
  providerId: openDesignDeployProviderSchema,
  /** 新 token（掩码原样回传表示沿用已保存值）。 */
  token: z.string().max(512).optional(),
  accountId: z.string().max(120).optional(),
  teamId: z.string().max(120).optional(),
  teamSlug: z.string().max(120).optional(),
});
export type OpenDesignHostDeployConfigUpdate = z.infer<
  typeof openDesignHostDeployConfigUpdateSchema
>;

export const openDesignHostDeployRequestSchema = z.object({
  projectId: z.string().min(1),
  /** 要发布的文件（缺省取画布入口文件）。 */
  file: z.string().min(1).max(240).optional(),
  providerId: openDesignDeployProviderSchema,
});
export type OpenDesignHostDeployRequest = z.infer<
  typeof openDesignHostDeployRequestSchema
>;

/** 一条部署记录（上游 publicDeployment 的收口面）。 */
export const openDesignHostDeploymentSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  fileName: z.string().min(1),
  providerId: z.string().min(1),
  url: z.string().min(1),
  target: z.string().nullable(),
  status: z.string().nullable(),
  createdAt: z.number().int().nullable(),
  updatedAt: z.number().int().nullable(),
});
export type OpenDesignHostDeployment = z.infer<
  typeof openDesignHostDeploymentSchema
>;

export const openDesignHostDeploymentsResponseSchema = z.object({
  deployments: z.array(openDesignHostDeploymentSchema).max(200),
});
export type OpenDesignHostDeploymentsResponse = z.infer<
  typeof openDesignHostDeploymentsResponseSchema
>;

/** Cloudflare 域名区清单（发布到自定义域时选）。 */
export const openDesignHostCloudflareZonesResponseSchema = z.object({
  zones: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
      }),
    )
    .max(500),
});
export type OpenDesignHostCloudflareZonesResponse = z.infer<
  typeof openDesignHostCloudflareZonesResponseSchema
>;

/* ------------------------------------------------------------------
 * 保存到工作目录（引擎 → 我们）：把画布文件（缺省入口 HTML）写进当前 Task 的
 * 工作目录——上游产物反向落到本仓文件树，与「同步到引擎」凑成双向。
 * ------------------------------------------------------------------ */

export const openDesignHostSaveToWorkspaceRequestSchema = z.object({
  projectId: z.string().min(1),
  /** 要保存的文件（缺省取画布入口文件）。 */
  file: z.string().min(1).max(240).optional(),
  /** 当前 Task 工作目录（绝对路径；服务端做越界与存在性校验）。 */
  workspacePath: z.string().min(1).max(1024),
});
export type OpenDesignHostSaveToWorkspaceRequest = z.infer<
  typeof openDesignHostSaveToWorkspaceRequestSchema
>;

export const openDesignHostSaveToWorkspaceResponseSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().min(0),
});
export type OpenDesignHostSaveToWorkspaceResponse = z.infer<
  typeof openDesignHostSaveToWorkspaceResponseSchema
>;

/* ------------------------------------------------------------------
 * 浏览器页面同步到画布（PR-4）：右栏 CDP 浏览器「同步到画布」——截图 PNG 落
 * 项目的 browser/ 目录，URL 与截图引用追加进 document.md 的 browser 受管段，
 * 引擎生成时能“看到”我们浏览的页面。
 * ------------------------------------------------------------------ */

export const openDesignHostBrowserPageRequestSchema = z.object({
  url: z.string().min(1).max(2048),
  /** 视口截图（PNG base64；缺省只记 URL）。 */
  screenshotBase64: z.string().max(24_000_000).optional(),
  title: z.string().max(240).optional(),
});
export type OpenDesignHostBrowserPageRequest = z.infer<
  typeof openDesignHostBrowserPageRequestSchema
>;

export const openDesignHostBrowserPageResponseSchema = z.object({
  project: z.object({ projectId: z.string().min(1), name: z.string() }),
  screenshotFile: z.string().nullable(),
});
export type OpenDesignHostBrowserPageResponse = z.infer<
  typeof openDesignHostBrowserPageResponseSchema
>;
