import { z } from "zod";

/**
 * flow 宿主适配层契约（`ff-embed/v1`）。
 *
 * 定位：flow 子系统（`flow/` 子模块）被主仓当**外壳**嵌进来时，走的是宿主适配层六缝
 * ——身份 / 凭证 / 计费 / 事件 / 主题 / 导航。本文件只定义**宿主侧**（本仓）对 flow 网关
 * 暴露的回调形状；flow 网关里的同名 DTO 是另一份实现（跨仓库不共享代码），两边靠本文件
 * 与 `flow/docs/ff-embed-v1.md` 对齐。
 *
 * 方向约定：
 * - 身份：flow 网关 → 宿主（本文件的 `POST /api/flow/host/identity`）；
 * - 凭证 / 计费 / 事件：同为 flow 网关 → 宿主（P3/P4/P5 逐个接上，形状同样落在这里）。
 *
 * 鉴权约定：调用方（flow 网关）用**共享密钥**做 bearer（`KENFUTWORK_FLOW_EMBED_SECRET`
 * ↔ flow 侧 `HOST_SHARED_SECRET`），请求体里的宿主令牌再被当作宿主会话验一次——两道门
 * 缺一不可，任一不过都如实拒绝。
 */
export const FLOW_EMBED_PROTOCOL_VERSION = "v1";

/**
 * 身份交换请求：`token` 是宿主会话令牌（浏览器里那份），由 flow 网关原样转交。
 * 长度上限是防线也是实测（超长串没有验签价值，只用来烧 CPU）。
 */
export const flowHostIdentityRequestSchema = z.object({
  token: z.string().min(1).max(8192),
  protocolVersion: z.string().min(1).max(16).optional(),
});

export const flowHostIdentityResponseSchema = z.object({
  /** 宿主侧的稳定主体标识（本仓取用户 id）：flow 按它 get-or-create 自己的用户。 */
  subject: z.string().min(1).max(256),
  displayName: z.string().max(128).optional(),
  email: z.string().max(320).optional(),
});

export type FlowHostIdentityRequest = z.infer<
  typeof flowHostIdentityRequestSchema
>;
export type FlowHostIdentityResponse = z.infer<
  typeof flowHostIdentityResponseSchema
>;
