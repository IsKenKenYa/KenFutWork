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
 * `od/v1` 嵌入协议（O2：iframe 双向链接的最小档）
 *
 * 方向约定（与 `ff-embed/v1` 同思路，但只做「链接」这一件事，不做身份/凭证）：
 * - 宿主 → 面板：`od/hello-ack`（握手应答）与 `od/navigate`（深链打开一个路径）；
 * - 面板 → 宿主：`od/hello`（握手）与 `od/navigate-complete`（深链已就位）。
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
  z.object({
    type: z.literal("od/navigate-complete"),
    version: z.string().min(1).max(16),
    path: z.string().min(1).max(2048),
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
  z.object({
    type: z.literal("od/navigate"),
    version: z.string().min(1).max(16),
    path: z.string().min(1).max(2048),
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

export function buildOpenDesignNavigate(
  path: string,
): OpenDesignOutboundMessage {
  return {
    type: "od/navigate",
    version: OPEN_DESIGN_EMBED_PROTOCOL_VERSION,
    path,
  };
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
