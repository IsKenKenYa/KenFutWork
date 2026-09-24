import { timingSafeEqual } from "node:crypto";

import {
  applicationErrorResponseSchema,
  FLOW_EMBED_PROTOCOL_VERSION,
  flowHostIdentityRequestSchema,
  flowHostIdentityResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";

/**
 * flow 宿主适配层的宿主侧路由（`ff-embed/v1`）。
 *
 * 调用方是 flow 网关（`flow/` 子模块），两条门都要过：
 * 1. **共享密钥**（`Authorization: Bearer <KENFUTWORK_FLOW_EMBED_SECRET>`）——证明对方是本
 *    实例认可的 flow 网关，而不是任何能访问本端口的进程；
 * 2. **宿主会话令牌**（请求体 `token`）——证明这次交换背后真有一个登录用户，且身份由
 *    宿主自己签发（flow 侧只拿到 subject，不自己造账号）。
 *
 * 本组路由是**基础设施**：没配共享密钥时如实回 503 并说明原因，而不是假装能用。
 * flow 模式在前端是否出现由插件安装态决定（见 `plugins/flow`）。
 */
export async function registerFlowHostRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    viewer: ViewerService;
    /** 共享密钥；缺省表示本实例未启用 flow 宿主能力。 */
    secret?: string | undefined;
  },
): Promise<void> {
  const sendUnauthorized = (reply: FastifyReply, message: string) =>
    reply
      .code(401)
      .send(
        unauthenticatedErrorResponseSchema.parse({
          error: { code: "unauthorized", message },
        }),
      );

  const sendUnavailable = (reply: FastifyReply, message: string) =>
    reply.code(503).send(
      applicationErrorResponseSchema.parse({
        error: { code: "service_unavailable", message },
      }),
    );

  const sendBadInput = (reply: FastifyReply, message: string) =>
    reply.code(400).send(
      applicationErrorResponseSchema.parse({
        error: { code: "application_error", message },
      }),
    );

  /** 定长比较，避免按前缀早退泄漏密钥形状。 */
  const secretMatches = (provided: string, expected: string): boolean => {
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  };

  const bearerFrom = (header: string | undefined): string => {
    if (!header) return "";
    const prefix = "Bearer ";
    return header.startsWith(prefix) ? header.slice(prefix.length).trim() : "";
  };

  app.post("/api/flow/host/identity", async (request, reply) => {
    const secret = options.secret?.trim();
    if (!secret) {
      return sendUnavailable(
        reply,
        "本实例未配置 KENFUTWORK_FLOW_EMBED_SECRET：flow 宿主身份交换未启用。",
      );
    }
    if (!secretMatches(bearerFrom(request.headers.authorization), secret)) {
      return sendUnauthorized(reply, "flow 网关共享密钥不匹配。");
    }
    // 协议版本：带上就必须是宿主认识的版本，否则明确拒绝（不静默按 v1 处理）。
    const protocol = String(
      request.headers["x-ff-embed-protocol"] ?? "",
    ).trim();
    if (protocol && protocol !== FLOW_EMBED_PROTOCOL_VERSION) {
      return sendBadInput(
        reply,
        `ff-embed 协议版本不匹配：宿主支持 ${FLOW_EMBED_PROTOCOL_VERSION}，收到 ${protocol}。`,
      );
    }

    const parsed = flowHostIdentityRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendBadInput(
        reply,
        "身份交换请求不合法：缺少宿主会话令牌（token）。",
      );
    }

    // 用宿主令牌验一次会话（复用真实请求上下文：ip / origin 的判定不绕过）。
    const user = await options.auth.authenticate({
      headers: {
        ...request.headers,
        authorization: `Bearer ${parsed.data.token}`,
      },
      ip: request.ip,
    });
    if (!user) {
      return sendUnauthorized(reply, "宿主会话令牌无效或已过期。");
    }

    // 显示名取 viewer 档案；档案缺失不阻断身份交换（flow 侧有邮箱/ID 兜底）。
    const viewer = await options.viewer
      .ensureViewer(user)
      .catch(() => undefined);
    const displayName = viewer?.profile?.displayName?.trim();

    return reply.code(200).send(
      flowHostIdentityResponseSchema.parse({
        subject: user.id,
        ...(displayName ? { displayName } : {}),
        ...(user.email ? { email: user.email } : {}),
      }),
    );
  });
}
