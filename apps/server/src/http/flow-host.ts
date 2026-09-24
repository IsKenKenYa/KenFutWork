import { timingSafeEqual } from "node:crypto";

import {
  applicationErrorResponseSchema,
  FLOW_EMBED_PROTOCOL_VERSION,
  flowHostBillingRequestSchema,
  flowHostBillingResponseSchema,
  flowHostCredentialsRequestSchema,
  flowHostCredentialsResponseSchema,
  flowHostIdentityRequestSchema,
  flowHostIdentityResponseSchema,
  flowHostStatusResponseSchema,
  type ProviderInstanceResponse,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  type CreditService,
  CreditServiceError,
} from "../features/credits/credit-service.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";

function isEnabledDifyEngine(instance: ProviderInstanceResponse): boolean {
  return instance.protocol === "dify-engine" && instance.enabled;
}

/**
 * flow 宿主适配层的宿主侧路由（`ff-embed/v1`）。
 *
 * 调用方与门禁：
 * - `POST /api/flow/host/identity`、`POST /api/flow/host/credentials`：调用方是 flow 网关
 *   （`flow/` 子模块），两条门都要过：
 *   1. **共享密钥**（`Authorization: Bearer <KENFUTWORK_FLOW_EMBED_SECRET>`）——证明对方是本
 *      实例认可的 flow 网关，而不是任何能访问本端口的进程；
 *   2. **宿主会话令牌**（请求体 `token`）——证明这次交换背后真有一个登录用户，且身份由
 *      宿主自己签发（flow 侧只拿到 subject / 引擎凭证，不自己造账号）。
 * - `GET /api/flow/host/status`：调用方是本仓自己的前端（工作台），会话鉴权即可；
 *   它是能力探针，**未配置时也要能如实回答 disabled**（而不是 404），否则前端没法区分
 *   「没配」和「没有这个功能」。
 *
 * 凭证缝（P3）：把工作区（回退平台池）里 `protocol='dify-engine'` 实例的引擎地址与 Key
 * 下发给 flow 网关。**没配实例时明确 404 并指路**——不静默回落 `.env`（那会用我们自己的
 * Key 办宿主的请求；要回落就别配 flow 侧的 HOST_CREDENTIALS_URL）。
 *
 * 本组路由是**基础设施**：没配共享密钥时身份/凭证交换如实回 503 并说明原因，而不是假装能用。
 * flow 模式在前端是否出现由插件安装态 + status.enabled 共同决定（见 `plugins/flow`）。
 */
export async function registerFlowHostRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    viewer: ViewerService;
    /** BYOK 供应商缝：dify-engine 实例的查询与凭证解析。 */
    providers: Pick<
      ModelProviderService,
      "listSystemInstances" | "resolveCredentialsById"
    >;
    /** credits 缝：flow 三段事务（P4）。 */
    credits: Pick<
      CreditService,
      "flowReserveCredits" | "flowSettleCredits" | "flowRefundCredits"
    >;
    /**
     * 宿主 subject（身份缝下发的宿主用户 id）→ 计费归属。
     * 实现由装配层用 persistence 提供（见 features/flow/plugin.ts）。
     */
    accounts: {
      findBySubject(
        subject: string,
      ): Promise<{ userId: string; workspaceId: string | null } | null>;
    };
    /** 共享密钥；缺省表示本实例未启用 flow 宿主能力。 */
    secret?: string | undefined;
    /** flow 前端地址（`KENFUTWORK_FLOW_FRONTEND_URL`）；iframe src 与 postMessage origin。 */
    frontendUrl?: string | undefined;
  },
): Promise<void> {
  const sendUnauthorized = (reply: FastifyReply, message: string) =>
    reply.code(401).send(
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

  const sendNotFound = (reply: FastifyReply, message: string) =>
    reply.code(404).send(
      applicationErrorResponseSchema.parse({
        error: { code: "flow_engine_not_configured", message },
      }),
    );

  const sendConflict = (reply: FastifyReply, message: string) =>
    reply.code(409).send(
      applicationErrorResponseSchema.parse({
        error: { code: "flow_engine_invalid", message },
      }),
    );

  /** 计费缝的 409（与 credits 缝的 conflict 同码，便于 flow 侧统一处理）。 */
  const sendBillingConflict = (reply: FastifyReply, message: string) =>
    reply.code(409).send(
      applicationErrorResponseSchema.parse({
        error: { code: "flow_billing_conflict", message },
      }),
    );

  /** credits 缝的错误透传（CreditServiceError 的 code 都在应用错误码封闭集合里）。 */
  const sendCreditError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof CreditServiceError) {
      return reply.code(error.statusCode).send(
        applicationErrorResponseSchema.parse({
          error: { code: error.code, message: error.message },
        }),
      );
    }
    return reply.code(500).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: "flow_billing_failed",
          message: `flow 计费失败：${error instanceof Error ? error.message : String(error)}`,
        },
      }),
    );
  };

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

  app.get("/api/flow/host/status", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return sendUnauthorized(reply, "Missing or invalid bearer token.");
    }

    const reasons: string[] = [];
    if (!options.secret?.trim()) {
      reasons.push(
        "未配置 KENFUTWORK_FLOW_EMBED_SECRET（flow 网关回调宿主的共享密钥）。",
      );
    }
    const frontendUrl = options.frontendUrl?.trim() || null;
    if (!frontendUrl) {
      reasons.push(
        "未配置 KENFUTWORK_FLOW_FRONTEND_URL（flow 前端地址，iframe 加载用）。",
      );
    }
    return reply.code(200).send(
      flowHostStatusResponseSchema.parse({
        enabled: reasons.length === 0,
        frontendUrl,
        reasons,
      }),
    );
  });

  app.post("/api/flow/host/credentials", async (request, reply) => {
    const secret = options.secret?.trim();
    if (!secret) {
      return sendUnavailable(
        reply,
        "本实例未配置 KENFUTWORK_FLOW_EMBED_SECRET：flow 宿主凭证下发未启用。",
      );
    }
    if (!secretMatches(bearerFrom(request.headers.authorization), secret)) {
      return sendUnauthorized(reply, "flow 网关共享密钥不匹配。");
    }
    const protocol = String(
      request.headers["x-ff-embed-protocol"] ?? "",
    ).trim();
    if (protocol && protocol !== FLOW_EMBED_PROTOCOL_VERSION) {
      return sendBadInput(
        reply,
        `ff-embed 协议版本不匹配：宿主支持 ${FLOW_EMBED_PROTOCOL_VERSION}，收到 ${protocol}。`,
      );
    }
    const parsed = flowHostCredentialsRequestSchema.safeParse(
      request.body ?? {},
    );
    if (!parsed.success) {
      return sendBadInput(reply, "凭证下发请求不合法：protocolVersion 超长。");
    }

    // 部署级解析：flow 网关一个引擎配置供全体用户（与 flow 侧
    // EmbeddedCredentialsProvider 的实际调用形状一致），来源是平台池。
    const systemInstances = await options.providers
      .listSystemInstances()
      .catch(() => [] as ProviderInstanceResponse[]);
    const candidate = systemInstances.find(isEnabledDifyEngine);
    if (!candidate) {
      return sendNotFound(
        reply,
        "平台池没有启用的 Dify 引擎实例（protocol=dify-engine）。" +
          "请在 管理后台 → 系统供应商 添加；或撤掉 flow 侧 HOST_CREDENTIALS_URL，" +
          "让 flow 网关回落自己的 .env 全局密钥。",
      );
    }

    const credentials = await options.providers.resolveCredentialsById(
      candidate.id,
    );
    const apiBase = credentials.baseUrl?.trim().replace(/\/+$/, "");
    if (!apiBase) {
      return sendConflict(
        reply,
        `Dify 引擎实例「${candidate.name}」缺少 base_url：引擎地址是凭证下发的必要字段，` +
          "请在 管理后台 → 系统供应商 补齐。",
      );
    }
    if (!/^https?:\/\//.test(apiBase)) {
      return sendConflict(
        reply,
        `Dify 引擎实例「${candidate.name}」的 base_url 不是 http(s) 地址：${apiBase}。`,
      );
    }

    // 明文 Key 只出现在这个响应里（共享密钥门过了的 flow 网关），不落日志。
    return reply.code(200).send(
      flowHostCredentialsResponseSchema.parse({
        apiBase,
        apiKey: credentials.apiKey,
        label: candidate.name,
      }),
    );
  });

  app.post("/api/flow/host/billing", async (request, reply) => {
    const secret = options.secret?.trim();
    if (!secret) {
      return sendUnavailable(
        reply,
        "本实例未配置 KENFUTWORK_FLOW_EMBED_SECRET：flow 宿主计费未启用。",
      );
    }
    if (!secretMatches(bearerFrom(request.headers.authorization), secret)) {
      return sendUnauthorized(reply, "flow 网关共享密钥不匹配。");
    }
    const parsed = flowHostBillingRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendBadInput(
        reply,
        `计费请求不合法：${parsed.error.issues[0]?.message ?? "形状不符合契约"}。`,
      );
    }
    const payload = parsed.data;

    // hostSubject → 宿主账号 → 个人工作区（身份缝交换时宿主自己下发的稳定标识）。
    // 两种「归属解析不了」都是 409 flow_billing_conflict：对 flow 网关而言同一类
    // 可操作错误（等宿主侧补配置/引导），不需要再区分状态码。
    const account = await options.accounts.findBySubject(payload.hostSubject);
    if (!account) {
      return sendBillingConflict(
        reply,
        `宿主用户 ${payload.hostSubject} 不存在：计费归属必须来自身份缝交换过的账号。`,
      );
    }
    const workspaceId = account.workspaceId;
    if (!workspaceId) {
      return sendBillingConflict(
        reply,
        `宿主用户 ${payload.hostSubject} 还没有个人工作区：请先在宿主侧完成一次登录引导。`,
      );
    }

    // 金额口径：宿主 credits 单位取整（预扣向上取整不低估占用；结算四舍五入）。
    const userId = account.userId;
    try {
      if (payload.op === "reserve") {
        const result = await options.credits.flowReserveCredits({
          amount: Math.max(0, Math.ceil(payload.amount)),
          runId: payload.runId,
          userId,
          workspaceId,
        });
        return reply.code(200).send(
          flowHostBillingResponseSchema.parse({
            op: "reserve",
            replayed: result.replayed,
            amount: result.frozenAmount,
          }),
        );
      }
      if (payload.op === "settle") {
        const result = await options.credits.flowSettleCredits({
          actualCost: Math.max(0, Math.round(payload.actualCost)),
          runId: payload.runId,
          userId,
          workspaceId,
        });
        return reply.code(200).send(
          flowHostBillingResponseSchema.parse({
            op: "settle",
            replayed: result.replayed,
            settledAmount: result.settledAmount,
            uncoveredAmount: result.uncoveredAmount,
          }),
        );
      }
      const result = await options.credits.flowRefundCredits({
        runId: payload.runId,
        userId,
        workspaceId,
      });
      return reply.code(200).send(
        flowHostBillingResponseSchema.parse({
          op: "refund",
          replayed: result.replayed,
          amount: result.releasedAmount,
        }),
      );
    } catch (error) {
      return sendCreditError(reply, error);
    }
  });

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
