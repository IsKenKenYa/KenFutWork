import { timingSafeEqual } from "node:crypto";
import {
  applicationErrorResponseSchema,
  FLOW_EMBED_PROTOCOL_VERSION,
  type FlowEngineInstallStatus,
  type FlowEngineLaunch,
  type FlowEngineStackContainer,
  type FlowHostEngineResponse,
  flowEngineInstallStatusSchema,
  flowHostCredentialsRequestSchema,
  flowHostCredentialsResponseSchema,
  flowHostEngineInfoResponseSchema,
  flowHostEngineInstallRequestSchema,
  flowHostEngineStopRequestSchema,
  flowHostEventsRequestSchema,
  flowHostEventsResponseSchema,
  flowHostIdentityRequestSchema,
  flowHostIdentityResponseSchema,
  flowHostIdentityTicketResponseSchema,
  flowHostStatusResponseSchema,
  flowRunEventSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../features/local-instance/types.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type { WsServices } from "../kernel/types.js";
import { flowEventScopeKey } from "../ws/event-buffer.js";

/** Flow 的凭据、事件、身份与引擎探测基础设施（本地实例身份适配见 `identity`）。 */
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
      /**
       * flowRun 事件入 EventBuffer（P5）：`flow.resume` 从这里补发断线期间的事件。
       * 缺省（测试/未挂载）时只广播不缓冲，行为与从前一致。
       */
      eventBuffer?: Pick<WsServices["eventBuffer"], "push">;
    };
    engine: { probe(): Promise<FlowHostEngineResponse> };
    /**
     * 本地实例身份缝（`ff-embed/v1`）：`issue` 凭本机接入签发一次性短时票据；
     * `verify` 在网关带票据回来时换出稳定身份（subject = 本实例 instanceId）。
     */
    identity: {
      issue(actor: LocalActor): Promise<{
        token: string;
        expiresAt: string;
      }>;
      verify(token: string): Promise<{
        subject: string;
        displayName?: string;
      } | null>;
    };
    /** 引擎栈托管（FORM-11）：确认后按承载目标拉镜像起栈，状态可轮询。 */
    engineInstall: {
      start(launch?: FlowEngineLaunch): {
        started: boolean;
        snapshot: FlowEngineInstallStatus;
      };
      status(): FlowEngineInstallStatus;
    };
    /** 引擎栈停止/卸载（FORM-11 生命周期）：`deleteData` 显式选择才全删容器卷。 */
    engineStop: {
      stop(input: { deleteData: boolean }): Promise<{
        ok: boolean;
        error?: string;
      }>;
    };
    /**
     * 引擎信息页的数据面（`GET /api/flow/host/engine/info`）：托管状态 + 承载探测 +
     * 栈容器事实 + 当前承载目标 + 地址/路径一次取全。由装配层实现（compose 文件与数据目录只在它那里）。
     */
    engineInfo?: {
      info(): Promise<{
        install: FlowEngineInstallStatus;
        probe: FlowHostEngineResponse;
        stack: { containers: FlowEngineStackContainer[]; error?: string };
        runtime: FlowEngineLaunch;
        addresses: { composeFile: string; dataDir: string };
      }>;
    };
    /** 共享密钥；缺省表示本实例未启用 flow 宿主能力。 */
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
    const reasons: string[] = [];
    if (!options.secret?.trim()) reasons.push("未配置 Flow 网关共享密钥。");
    if (!options.frontendUrl?.trim()) reasons.push("未配置 Flow 前端地址。");
    return reply.send(
      flowHostStatusResponseSchema.parse({
        enabled: reasons.length === 0,
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

  /**
   * 宿主前端换身份票据（本机接入验证）：带 cookie/Bearer 的浏览器调用，
   * 握手时随 `ff-embed/identity` 交给 flow 前端，再由 flow 网关带回验签。
   */
  app.post("/api/flow/host/identity-ticket", async (request, reply) => {
    const actor = await options.localAccess.authenticate(request);
    if (!actor) return unauthorized(reply, "缺少或无效的本机接入凭据。");
    await options.localInstance.resolve(actor);
    return reply
      .code(200)
      .send(
        flowHostIdentityTicketResponseSchema.parse(
          await options.identity.issue(actor),
        ),
      );
  });

  /**
   * 身份验签（flow 网关 → 宿主，共享密钥门）：票据一次性消费；验出稳定 subject
   * 供 flow 侧 get-or-create。没验过就不发身份（401），不接受伪造令牌。
   *
   * `skipLocalAccess`：机器对机器路由自带共享密钥门，没有本机接入凭据——
   * 跳过本机接入总门（见 local-access 的 isLocalAccessExempt）。
   */
  app.post(
    "/api/flow/host/identity",
    { config: { skipLocalAccess: true } },
    async (request, reply) => {
      if (!gatewayAuthorized(request, reply)) return;
      const parsed = flowHostIdentityRequestSchema.safeParse(
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
          "Flow 身份请求格式或版本不正确。",
        );
      const identity = await options.identity.verify(parsed.data.token);
      if (!identity)
        return unauthorized(reply, "宿主身份票据无效、已过期或已使用。");
      return reply.send(flowHostIdentityResponseSchema.parse(identity));
    },
  );
  app.post("/api/flow/host/engine/install", async (request, reply) => {
    const actor = await options.localAccess.authenticate(request);
    if (!actor) return unauthorized(reply, "缺少或无效的本机接入凭据。");
    await options.localInstance.resolve(actor);
    // 承载目标（FORM-11 双 Provider）：缺省 host；选定后落盘，停止/查询都按它执行。
    const parsed = flowHostEngineInstallRequestSchema.safeParse(
      request.body ?? {},
    );
    if (!parsed.success)
      return error(reply, 400, "application_error", "安装请求格式不正确。");
    // 确认闸：这是用户点「安装引擎」后的入口；已在安装中则 409（轮询 status 即可）。
    const { started, snapshot } = options.engineInstall.start(parsed.data.launch);
    if (!started && snapshot.state === "installing") {
      return reply.code(409).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "flow_engine_install_running",
            message: "引擎栈安装已在进行中，请轮询 status 端点。",
          },
        }),
      );
    }
    return reply.code(200).send(flowEngineInstallStatusSchema.parse(snapshot));
  });

  app.get("/api/flow/host/engine/install/status", async (request, reply) => {
    const actor = await options.localAccess.authenticate(request);
    if (!actor) return unauthorized(reply, "缺少或无效的本机接入凭据。");
    await options.localInstance.resolve(actor);
    return reply
      .code(200)
      .send(
        flowEngineInstallStatusSchema.parse(options.engineInstall.status()),
      );
  });

  /**
   * 停止/卸载引擎栈（FORM-11 生命周期）：默认 `down` 保留数据卷；`deleteData: true`
   * 才 `down --volumes` 全删（§9.1③——显式选择才动数据）。失败原样给可读原因（503）。
   */
  app.post("/api/flow/host/engine/stop", async (request, reply) => {
    const actor = await options.localAccess.authenticate(request);
    if (!actor) return unauthorized(reply, "缺少或无效的本机接入凭据。");
    await options.localInstance.resolve(actor);
    const parsed = flowHostEngineStopRequestSchema.safeParse(
      request.body ?? {},
    );
    if (!parsed.success)
      return error(reply, 400, "application_error", "停止请求格式不正确。");
    const result = await options.engineStop.stop({
      deleteData: parsed.data.deleteData === true,
    });
    if (!result.ok)
      return error(
        reply,
        503,
        "service_unavailable",
        result.error ?? "停止引擎栈失败。",
      );
    return reply
      .code(200)
      .send(
        flowEngineInstallStatusSchema.parse(options.engineInstall.status()),
      );
  });

  app.get("/api/flow/host/engine/info", async (request, reply) => {
    const actor = await options.localAccess.authenticate(request);
    if (!actor) return unauthorized(reply, "缺少或无效的本机接入凭据。");
    // 未装配数据面时如实回不可用（老装配不留假数据）。
    if (!options.engineInfo) {
      return error(reply, 503, "service_unavailable", "引擎信息数据面未装配。");
    }
    const info = await options.engineInfo.info();
    // 状态校正：安装状态快照是**进程内**的（服务重启归零为 idle），而栈可能仍在跑——
    // 有运行中的容器就按「已就绪」呈现（schema 注释里「由调用方按 compose ps 重新探测」
    // 指的就是这一步），否则用户会看到「未安装」与九个运行中容器同屏的矛盾画面。
    const stackRunning = info.stack.containers.some(
      (container) => container.state === "running",
    );
    const install =
      info.install.state === "idle" && stackRunning
        ? { ...info.install, state: "ready" as const }
        : info.install;
    // 宿主身份回调按**本次请求的主机名**拼：本实例可能是 127.0.0.1 / 局域网 IP / 域名，
    // 写死任一个都会在另一种入口下给出错地址。
    const hostIdentityUrl = `${request.protocol}://${request.headers.host ?? "127.0.0.1"}/api/flow/host/identity`;
    return reply.code(200).send(
      flowHostEngineInfoResponseSchema.parse({
        install,
        probe: info.probe,
        stack: info.stack,
        // 承载目标（落盘记录）：界面按它显示「承载 WSL2 · Ubuntu / 本机容器」
        runtime: info.runtime,
        addresses: {
          frontendUrl: options.frontendUrl?.trim() || null,
          hostIdentityUrl,
          composeFile: info.addresses.composeFile,
          dataDir: info.addresses.dataDir,
        },
      }),
    );
  });

  app.post(
    "/api/flow/host/credentials",
    { config: { skipLocalAccess: true } },
    async (request, reply) => {
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
    },
  );

  app.post(
    "/api/flow/host/events",
    { config: { skipLocalAccess: true } },
    async (request, reply) => {
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
        options.ws.connectionManager.pushToInstance(
          instanceId,
          streamEvent.data,
        );
        // 同时入缓冲：断线重连走 `flow.resume` 补发（P5）
        options.ws.eventBuffer?.push(
          flowEventScopeKey(instanceId),
          streamEvent.data,
        );
        accepted += 1;
      }
      return reply.send(
        flowHostEventsResponseSchema.parse({ accepted, skipped }),
      );
    },
  );
}
