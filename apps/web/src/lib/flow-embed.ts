import type { FlowHostStatusResponse } from "@kenfutwork/shared";

/**
 * Flow 模式入口门控（纯逻辑，接线在 `hooks/use-flow-host.ts`）。
 *
 * 入口纪律（《flow 集成方案》P2 / AGENTS.md 不变量）：flow 以插件形态交付，
 * **未安装插件或宿主适配层未配齐时不出现 Flow 入口**——不摆空壳、不放假开关。
 * 两个条件各自可判定：
 *  - 插件安装态：`GET /api/plugins` 里有 `kenfutwork-flow` 且 `installed`；
 *  - 适配层配齐：`GET /api/flow/host/status` 回 `enabled`（缺什么 reasons 里点名）。
 */

export type FlowEntry =
  | { available: true; frontendUrl: string }
  | { available: false; reason: string };

export function resolveFlowEntry(input: {
  /** flow 插件（`kenfutwork-flow`）是否已安装。 */
  pluginInstalled: boolean;
  /** 宿主适配层状态；null = 探针请求失败（按不可用处理，不猜）。 */
  status: FlowHostStatusResponse | null;
}): FlowEntry {
  if (!input.pluginInstalled) {
    return {
      available: false,
      reason: "未安装 flow 插件（插件市场可安装）。",
    };
  }
  if (!input.status) {
    return {
      available: false,
      reason: "无法获取 flow 宿主状态（/api/flow/host/status 不可达）。",
    };
  }
  if (!input.status.enabled || !input.status.frontendUrl) {
    return {
      available: false,
      reason: input.status.reasons.length
        ? `宿主适配层未配齐：${input.status.reasons.join(" ")}`
        : "宿主适配层未配齐。",
    };
  }
  return { available: true, frontendUrl: input.status.frontendUrl };
}

/**
 * `ff-embed/v1` 宿主侧出站消息（唯一权威在 `flow/docs/ff-embed-v1.md` 与
 * flow 前端 `frontend/src/embed/protocol.ts`；这里只构造本仓要发的那两条）。
 */
export type FfEmbedOutboundMessage =
  | { type: "ff-embed/hello-ack"; version: string }
  | { type: "ff-embed/identity"; version: string; hostToken: string };

export function buildHelloAck(version: string): FfEmbedOutboundMessage {
  return { type: "ff-embed/hello-ack", version };
}

export function buildIdentity(
  version: string,
  hostToken: string,
): FfEmbedOutboundMessage {
  return { type: "ff-embed/identity", version, hostToken };
}

/** flow 前端会发来的消息类型（宿主侧只认这个集合，其余忽略）。 */
export type FfEmbedInboundMessage =
  | { type: "ff-embed/hello"; version?: unknown }
  | { type: "ff-embed/ready" }
  | { type: "ff-embed/run-event" }
  | { type: "ff-embed/navigation" }
  | { type: "ff-embed/error" }
  | { type: "ff-embed/bye" };

const INBOUND_TYPES = new Set([
  "ff-embed/hello",
  "ff-embed/ready",
  "ff-embed/run-event",
  "ff-embed/navigation",
  "ff-embed/error",
  "ff-embed/bye",
]);

/**
 * 解析一条来自 flow iframe 的消息。
 *
 * 安全边界（§3.3）：origin 必须等于 flow 前端 origin（服务端下发的
 * `KENFUTWORK_FLOW_FRONTEND_URL`），白名单外的消息**静默丢弃**——页面里可能
 * 同时有别的 iframe / 库在 postMessage，把噪音当故障会让排查看错方向。
 */
export function parseFlowInbound(
  raw: unknown,
  context: { origin: string; allowedOrigin: string },
): FfEmbedInboundMessage | null {
  if (context.origin !== context.allowedOrigin) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.type !== "string") return null;
  if (!INBOUND_TYPES.has(candidate.type)) return null;
  return candidate as FfEmbedInboundMessage;
}
