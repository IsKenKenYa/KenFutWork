import { timingSafeEqual } from "node:crypto";
import {
  applicationErrorResponseSchema,
  FLOW_EMBED_PROTOCOL_VERSION,
  type FlowHostEngineResponse,
  flowHostCredentialsRequestSchema,
  flowHostCredentialsResponseSchema,
  flowHostEventsRequestSchema,
  flowHostEventsResponseSchema,
  flowHostStatusResponseSchema,
  flowRunEventSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type { LocalInstanceService } from "../features/local-instance/types.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type { WsServices } from "../kernel/types.js";

/** Flow 的凭据、事件与引擎探测基础设施；本地身份适配未接通前产品入口保持关闭。 */
export async function registerFlowHostRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    localInstance: LocalInstanceService;
    providers: Pick<
      ModelProviderService,
      "listInstances" | "resolveCredentialsById"
    >;
    ws: {
      connectionManager: Pick<
        WsServices["connectionManager"],
        "pushToInstance"
      >;
    };
    engine: { probe(): Promise<FlowHostEngineResponse> };
    secret?: string | undefined;
    frontendUrl?: string | undefined;
  },
): Promise<void> {
  const error = (
    reply: FastifyReply,
    status: number,
    code:
      | "service_unavailable"
      | "application_error"
      | "flow_engine_not_configured"
      | "flow_engine_invalid",
    message: string,
  ) =>
    reply
      .code(status)
      .send(applicationErrorResponseSchema.parse({ error: { code, message } }));
  const unauthorized = (reply: FastifyReply, message: string) =>
    reply.code(401).send(
      unauthenticatedErrorResponseSchema.parse({
        error: { code: "unauthorized", message },
      }),
    );
  const gatewayAuthorized = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): boolean => {
    const expected = options.secret?.trim();
    if (!expected) {
      error(
        reply,
        503,
        "service_unavailable",
        "未配置 Flow 网关共享密钥，宿主回调不可用。",
      );
      return false;
    }
    const header = request.headers.authorization;
    const provided = header?.startsWith("Bearer ")
      ? header.slice(7).trim()
      : "";
    const actualBytes = Buffer.from(provided);
    const expectedBytes = Buffer.from(expected);
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      unauthorized(reply, "Flow 网关共享密钥不匹配。");
      return false;
    }
    const version = String(request.headers["x-ff-embed-protocol"] ?? "").trim();
    if (version && version !== FLOW_EMBED_PROTOCOL_VERSION) {
      error(
        reply,
        400,
        "application_error",
        `Flow 协议版本不匹配：支持 ${FLOW_EMBED_PROTOCOL_VERSION}。`,
      );
      return false;
    }
    return true;
  };

  app.get("/api/flow/host/status", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    const reasons = ["Flow 本地实例身份适配尚未接通，当前不提供工作流入口。"];
    if (!options.secret?.trim()) reasons.push("未配置 Flow 网关共享密钥。");
    if (!options.frontendUrl?.trim()) reasons.push("未配置 Flow 前端地址。");
    return reply.send(
      flowHostStatusResponseSchema.parse({
        enabled: false,
        frontendUrl: options.frontendUrl?.trim() || null,
        reasons,
      }),
    );
  });

  app.get("/api/flow/host/engine", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    return reply.send(await options.engine.probe());
  });

  app.post("/api/flow/host/identity", async (_request, reply) =>
    error(
      reply,
      503,
      "service_unavailable",
      "Flow 本地实例身份适配尚未接通，不交换本机接入凭据。",
    ),
  );

  app.post("/api/flow/host/credentials", async (request, reply) => {
    if (!gatewayAuthorized(request, reply)) return;
    const parsed = flowHostCredentialsRequestSchema.safeParse(
      request.body ?? {},
    );
    if (
      !parsed.success ||
      (parsed.data.protocolVersion &&
        parsed.data.protocolVersion !== FLOW_EMBED_PROTOCOL_VERSION)
    )
      return error(
        reply,
        400,
        "application_error",
        "Flow 凭据请求格式或版本不正确。",
      );
    const actor = await options.localInstance.serviceActor();
    const candidate = (await options.providers.listInstances(actor)).find(
      (instance) => instance.enabled && instance.protocol === "dify-engine",
    );
    if (!candidate)
      return error(
        reply,
        404,
        "flow_engine_not_configured",
        "请在本地供应商设置添加并启用 Dify 引擎实例。",
      );
    const credentials = await options.providers.resolveCredentialsById(
      candidate.id,
    );
    const apiBase = credentials.baseUrl?.trim().replace(/\/+$/, "");
    if (!apiBase || !/^https?:\/\//u.test(apiBase))
      return error(
        reply,
        409,
        "flow_engine_invalid",
        "Dify 引擎实例缺少有效的 http(s) 地址，请检查本地供应商设置。",
      );
    return reply.send(
      flowHostCredentialsResponseSchema.parse({
        apiBase,
        apiKey: credentials.apiKey,
        label: candidate.name,
      }),
    );
  });

  app.post("/api/flow/host/events", async (request, reply) => {
    if (!gatewayAuthorized(request, reply)) return;
    const parsed = flowHostEventsRequestSchema.safeParse(request.body ?? {});
    if (
      !parsed.success ||
      (parsed.data.protocolVersion &&
        parsed.data.protocolVersion !== FLOW_EMBED_PROTOCOL_VERSION)
    )
      return error(
        reply,
        400,
        "application_error",
        "Flow 事件请求格式或版本不正确。",
      );
    const { instanceId } = await options.localInstance.serviceActor();
    let accepted = 0;
    let skipped = 0;
    for (const event of parsed.data.events) {
      if (event.hostSubject !== instanceId) {
        skipped += 1;
        continue;
      }
      const streamEvent = flowRunEventSchema.safeParse({
        type: "flowRun.event",
        runId: event.runId,
        seq: event.seq,
        eventType: event.type,
        payload: event.payload,
        at: event.at,
        timestamp: event.at,
      });
      if (!streamEvent.success) {
        skipped += 1;
        continue;
      }
      options.ws.connectionManager.pushToInstance(instanceId, streamEvent.data);
      accepted += 1;
    }
    return reply.send(
      flowHostEventsResponseSchema.parse({ accepted, skipped }),
    );
  });
}
