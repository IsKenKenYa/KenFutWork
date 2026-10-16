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
 * `od/v1` 嵌入协议（O2：iframe 双向链接的最小档）
 *
 * 方向约定（与 `ff-embed/v1` 同思路，只做握手，不做身份/凭证）：
 * - 宿主 → 面板：`od/hello`（探测）与 `od/hello-ack`（握手应答）；
 * - 面板 → 宿主：`od/hello`（应答握手）。
 * 深链 `od/navigate` 曾按 O2 最小档实现，2026-10-15 随用户口径移除
 * （面板自动连接、打开、编辑画布本身即可；上游协议支持见 nexu-io/open-design#8776）。
 *
 * 安全口径（《OpenDesign 集成规划》§8 风险 5）：**origin 白名单 + 入站消息 schema 校验**。
 * 只收配置里那个前端 origin 发来的消息，schema 之外或类型不明的消息一律丢弃——
 * 不收「也许能用的宽进宽出」。
 * ------------------------------------------------------------------ */

export const OPEN_DESIGN_EMBED_PROTOCOL_VERSION = "v1";

/** 面板 → 宿主的入站消息。schema 之外一律视为噪声丢弃。 */
export const openDesignInboundMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("od/hello"),
    version: z.string().min(1).max(16),
  }),
]);
export type OpenDesignInboundMessage = z.infer<
  typeof openDesignInboundMessageSchema
>;

/** 宿主 → 面板的出站消息。 */
export const openDesignOutboundMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("od/hello"),
    version: z.string().min(1).max(16),
  }),
  z.object({
    type: z.literal("od/hello-ack"),
    version: z.string().min(1).max(16),
  }),
]);
export type OpenDesignOutboundMessage = z.infer<
  typeof openDesignOutboundMessageSchema
>;

export function buildOpenDesignHello(): OpenDesignOutboundMessage {
  return { type: "od/hello", version: OPEN_DESIGN_EMBED_PROTOCOL_VERSION };
}

export function buildOpenDesignHelloAck(): OpenDesignOutboundMessage {
  return { type: "od/hello-ack", version: OPEN_DESIGN_EMBED_PROTOCOL_VERSION };
}

/**
 * 入站消息的**来源**必须是配置里的前端 origin（origin 白名单）。
 * 事件 origin 与配置不一致即返回 null——跨源伪造直接丢，不做宽容处理。
 */
export function isAllowedOpenDesignOrigin(
  eventOrigin: string,
  allowedOrigin: string,
): boolean {
  return eventOrigin.length > 0 && eventOrigin === allowedOrigin;
}

/**
 * 入站消息的**内容**校验：过 schema 才认，其余（含类型不明的宽对象）一律 null。
 * 与 origin 白名单是两道独立的闸，缺一不可。
 */
export function parseOpenDesignInbound(
  raw: unknown,
): OpenDesignInboundMessage | null {
  const parsed = openDesignInboundMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

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
