import {
  applicationErrorResponseSchema,
  openDesignHostConfigResponseSchema,
  openDesignHostConfigUpdateSchema,
  openDesignHostCredentialsRequestSchema,
  openDesignHostCredentialsResponseSchema,
  openDesignHostStatusResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type { LocalActor } from "../features/local-instance/types.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type { OpenDesignCompanionSnapshot } from "../features/open-design/companion.js";
import { readOpenDesignLastProject } from "../features/open-design/last-project.js";
import { provisionOpenDesign } from "../features/open-design/provision.js";
import {
  readOpenDesignFileConfig,
  resolveOpenDesignConfigView,
  writeOpenDesignFileConfig,
} from "../features/open-design/config-store.js";
import {
  resolveOpenDesignCredentialEntries,
  resolveOpenDesignProtocolVersion,
} from "../features/open-design/credentials.js";
import { resolveOpenDesignHostStatus } from "../features/open-design/host-status.js";
import { authorizeOpenDesignGateway } from "./open-design-gateway-auth.js";

/**
 * OpenDesign 宿主路由（本机接入验证）。
 *
 * 与 flow 的分工一致（FORM-11）：**这里**是宿主适配层基础设施，`plugins/open-design`
 * 是产品入口（安装态决定右侧栏是否出现面板）。两条路由性格不同：
 *
 * - `GET /api/open-design/host/status`：**始终注册**的能力探针（本机接入门）——
 *   未配齐 / 服务不可达都要如实回答 disabled 与缺失原因，前端据此不摆空壳入口。
 * - `POST /api/open-design/host/credentials`（O3 / OD-4）：**网关门**（共享密钥），
 *   调用方是 OpenDesign daemon 而非浏览器——它没有本机接入票据。把本仓 BYOK 凭证
 *   下发给 daemon 驱动它的 coding-agent CLI。未配密钥时 503（这条缝没开），
 *   而不是 404——「没开」和「没有」要分得开。
 */
export async function registerOpenDesignHostRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    /** `KENFUTWORK_OPEN_DESIGN_FRONTEND_URL`；缺省表示未启用。 */
    frontendUrl?: string | undefined;
    /** 探活用 fetch（测试注入，避免真发网络请求）。 */
    fetchImpl?: typeof fetch | undefined;
    /** `KENFUTWORK_OPEN_DESIGN_EMBED_SECRET`；缺省 = 凭证缝未开（503）。 */
    secret?: string | undefined;
    /** BYOK 实例面（凭证缝装配；缺省 = 未接线，503）。 */
    providers?: Pick<
      ModelProviderService,
      "listInstances" | "resolveCredentialsById"
    >;
    /** 本机实例作用域（凭证缝装配；缺省 = 未接线，503）。 */
    localInstance?: { serviceActor(): Promise<LocalActor> };
    /** 伴随容器快照（§9-3 承载；缺省 = 不托管，status 只报 HTTP 事实）。 */
    companion?: (() => OpenDesignCompanionSnapshot) | undefined;
    /** 桌面数据目录（config 读写缝；缺省 = 不注册 config 路由，如远端自托管）。 */
    dataDir?: string | undefined;
  },
): Promise<void> {
  const error = (
    reply: FastifyReply,
    status: number,
    code:
      | "open_design_not_configured"
      | "open_design_credential_unavailable"
      | "service_unavailable"
      | "application_error",
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

  app.get("/api/open-design/host/status", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    return reply.send(
      openDesignHostStatusResponseSchema.parse(
        await resolveOpenDesignHostStatus({
          frontendUrl: options.frontendUrl,
          fetchImpl: options.fetchImpl,
          companion: options.companion?.(),
        }),
      ),
    );
  });

  /**
   * 就绪探针：上游有没有可用的设计引擎（agent CLI）。
   *
   * 没有可用 CLI 时 `agentId` 只能是 null，项目页会退到「模型与提供商」——
   * 面板据此说明原因，而不是让用户对着上游设置页猜「为什么没有画布」。
   */
  app.get("/api/open-design/host/readiness", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    const base = options.frontendUrl?.trim().replace(/\/+$/u, "") ?? "";
    if (!base)
      return reply.send({
        reachable: false,
        agentAvailable: false,
        agentId: null,
        onboardingCompleted: false,
      });
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeout = AbortSignal.timeout(OPEN_DESIGN_PROBE_TIMEOUT_MS);
    try {
      const [agentsResponse, configResponse] = await Promise.all([
        fetchImpl(`${base}/api/agents`, { signal: timeout }),
        fetchImpl(`${base}/api/app-config`, { signal: timeout }),
      ]);
      if (!agentsResponse.ok || !configResponse.ok)
        return reply.send({
          reachable: false,
          agentAvailable: false,
          agentId: null,
          onboardingCompleted: false,
        });
      const agents = (await agentsResponse.json()) as {
        agents?: Array<{ available?: boolean }>;
      };
      const config = (await configResponse.json()) as {
        config?: { agentId?: string | null; onboardingCompleted?: boolean };
      };
      const list = agents.agents ?? [];
      return reply.send({
        reachable: true,
        agentAvailable: list.some((agent) => agent.available === true),
        agentId: config.config?.agentId ?? null,
        onboardingCompleted: config.config?.onboardingCompleted === true,
      });
    } catch {
      return reply.send({
        reachable: false,
        agentAvailable: false,
        agentId: null,
        onboardingCompleted: false,
      });
    }
  });

  if (options.dataDir) {
    const dataDir = options.dataDir;
    // 右侧面板读「最近创建的项目」，据此把 iframe 定位到 /projects/<id>。
    app.get("/api/open-design/last-project", async (request, reply) => {
      if (!(await options.localAccess.authenticate(request)))
        return unauthorized(reply, "本机接入凭据缺失或无效。");
      return reply.send({ project: readOpenDesignLastProject({ dataDir }) });
    });
    // 桌面承载配置读写（§205 闭环）：本机接入门；文件值重启后经 Tauri 注入生效。
    app.get("/api/open-design/host/config", async (request, reply) => {
      if (!(await options.localAccess.authenticate(request)))
        return unauthorized(reply, "本机接入凭据缺失或无效。");
      return reply.send(
        openDesignHostConfigResponseSchema.parse(
          resolveOpenDesignConfigView({
            file: readOpenDesignFileConfig({ dataDir }),
            envFrontendUrl: options.frontendUrl,
            envSecret: options.secret,
          }),
        ),
      );
    });

    app.put("/api/open-design/host/config", async (request, reply) => {
      if (!(await options.localAccess.authenticate(request)))
        return unauthorized(reply, "本机接入凭据缺失或无效。");
      const parsed = openDesignHostConfigUpdateSchema.safeParse(
        request.body ?? {},
      );
      if (!parsed.success) {
        return error(
          reply,
          400,
          "application_error",
          "OpenDesign 承载配置格式不正确。",
        );
      }
      const frontendUrl = parsed.data.frontendUrl ?? null;
      if (frontendUrl) {
        // 与 env 的 parseHttpOrigin 同口径：只收 http(s) origin，不带路径/凭据
        let url: URL;
        try {
          url = new URL(frontendUrl);
        } catch {
          return error(
            reply,
            400,
            "application_error",
            "前端地址不是合法 URL，请填写 http(s) origin。",
          );
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return error(
            reply,
            400,
            "application_error",
            "前端地址只支持 http/https。",
          );
        }
        if (url.username || url.password || url.pathname !== "/") {
          return error(
            reply,
            400,
            "application_error",
            "前端地址只接受 origin，如 http://127.0.0.1:7456。",
          );
        }
      }
      writeOpenDesignFileConfig({
        dataDir,
        config: {
          frontendUrl,
          embedSecret: parsed.data.embedSecret ?? null,
        },
      });
      return reply.send(
        openDesignHostConfigResponseSchema.parse(
          resolveOpenDesignConfigView({
            file: readOpenDesignFileConfig({ dataDir }),
            envFrontendUrl: options.frontendUrl,
            envSecret: options.secret,
          }),
        ),
      );
    });
  }

  app.post(
    "/api/open-design/host/credentials",
    // 网关门自带鉴权（共享密钥），不走本机接入票据——调用方是 daemon。
    { config: { skipLocalAccess: true } },
    async (request, reply) => {
      if (!authorizeOpenDesignGateway(request, reply, options.secret)) return;
      if (!options.providers || !options.localInstance) {
        return error(
          reply,
          503,
          "service_unavailable",
          "OpenDesign 凭证缝未接线（providers / localInstance 缺失），请检查宿主装配。",
        );
      }
      const parsed = openDesignHostCredentialsRequestSchema.safeParse(
        request.body ?? {},
      );
      if (!parsed.success)
        return error(
          reply,
          400,
          "application_error",
          "OpenDesign 凭证请求格式不正确。",
        );
      const version = resolveOpenDesignProtocolVersion(
        parsed.data.protocolVersion,
      );
      if (!version.ok)
        return error(
          reply,
          400,
          "application_error",
          "OpenDesign 协议版本不匹配。",
        );

      // 守卫之后先捕获：闭包里读 options.localInstance 会丢掉 TS 的窄化。
      const localInstance = options.localInstance;
      const resolved = await resolveOpenDesignCredentialEntries({
        providers: options.providers,
        serviceActor: () => localInstance.serviceActor(),
      });
      if (!resolved.ok) {
        return error(
          reply,
          resolved.status,
          resolved.status === 404
            ? "open_design_not_configured"
            : "open_design_credential_unavailable",
          resolved.message,
        );
      }
      return reply.send(
        openDesignHostCredentialsResponseSchema.parse({
          protocolVersion: version.version,
          credentials: resolved.entries,
        }),
      );
    },
  );

  /**
   * 「配置设计引擎」：把本仓 BYOK 实例供给到**已运行**的上游（选 agent、写入模型）。
   *
   * 与伴随容器的自动引导同一套 `provisionOpenDesign`，区别是**由用户显式触发**：
   * 外部自管的 daemon 不该被我们偷偷写配置，尤其这一步会把 API Key 交给它。
   * 上游没完成引导（`agentId: null`）时，项目页只会停在「模型与提供商」，
   * 出不来画布——这个按钮就是解那个门槛的最小动作。
   */
  app.post("/api/open-design/host/provision", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    if (!options.providers || !options.localInstance)
      return error(
        reply,
        503,
        "service_unavailable",
        "OpenDesign 凭证缝未接线（providers / localInstance 缺失）。",
      );
    if (!options.frontendUrl?.trim())
      return error(
        reply,
        400,
        "open_design_not_configured",
        "未配置 OpenDesign 前端地址。",
      );
    const localInstance = options.localInstance;
    const resolved = await resolveOpenDesignCredentialEntries({
      providers: options.providers,
      serviceActor: () => localInstance.serviceActor(),
    });
    if (!resolved.ok)
      return error(
        reply,
        resolved.status,
        resolved.status === 404
          ? "open_design_not_configured"
          : "open_design_credential_unavailable",
        resolved.message,
      );
    const result = await provisionOpenDesign({
      baseUrl: options.frontendUrl,
      fetchImpl: options.fetchImpl ?? fetch,
      entries: resolved.entries,
    });
    return reply.send(result);
  });
}
