import {
  applicationErrorResponseSchema,
  openDesignHostCanvasResponseSchema,
  openDesignHostConfigResponseSchema,
  openDesignHostConfigUpdateSchema,
  openDesignHostCreateCanvasRequestSchema,
  openDesignHostCredentialsRequestSchema,
  openDesignHostCredentialsResponseSchema,
  openDesignHostFileTextResponseSchema,
  openDesignHostPreviewUrlResponseSchema,
  openDesignHostStatusResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type { LocalActor } from "../features/local-instance/types.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type { OpenDesignCompanionSnapshot } from "../features/open-design/companion.js";
import {
  readOpenDesignLastProject,
  writeOpenDesignLastProject,
} from "../features/open-design/last-project.js";
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
import {
  OPEN_DESIGN_PROBE_TIMEOUT_MS,
  resolveOpenDesignHostStatus,
} from "../features/open-design/host-status.js";
import { authorizeOpenDesignGateway } from "./open-design-gateway-auth.js";

/**
 * 画布数据面的本机守护进程调用上限。一次性局部常量（本地 companion 的 HTTP 读，
 * 不是 agent 治理数值），不进 `packages/shared/src/governance.ts`。
 */
const OPEN_DESIGN_CANVAS_TIMEOUT_MS = 5_000;

/**
 * 设计文本上限（光栅化在浏览器里做，超限的页面不做截图/导出，如实报错）。
 */
const OPEN_DESIGN_DESIGN_TEXT_MAX_LENGTH = 2 * 1024 * 1024;

interface DaemonProjectFile {
  name?: string;
  kind?: string;
  artifactManifest?: { entry?: string };
}

/** 画布要展示的文件：上游 artifactManifest.entry 优先，退第一个 html。 */
function pickEntryFile(files: DaemonProjectFile[]): string | null {
  const declared = files.find(
    (file) => file.name && file.artifactManifest?.entry === file.name,
  );
  if (declared?.name) return declared.name;
  const html = files.find((file) => file.kind === "html" && file.name);
  return html?.name ?? null;
}

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

  /* ---------------------------------------------------------------- *
   * 画布数据面（契约见 `@kenfutwork/shared` 的 open-design-host）：
   * 面板 iframe 只吃 daemon 的公开预览地址，其余读写都经宿主——浏览器直连
   * daemon 会撞 CORS（预检 403），且宿主是维护「最近画布」槽位的唯一地方。
   * ---------------------------------------------------------------- */

  const canvasBaseUrl = (reply: FastifyReply): string | null => {
    const base = options.frontendUrl?.trim().replace(/\/+$/u, "") ?? "";
    if (!base) {
      void error(
        reply,
        400,
        "open_design_not_configured",
        "未配置 OpenDesign 前端地址。",
      );
      return null;
    }
    return base;
  };

  const daemonJson = async <T>(
    base: string,
    path: string,
    init?: RequestInit,
  ): Promise<
    { ok: true; value: T } | { ok: false; status: number; message: string }
  > => {
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(OPEN_DESIGN_CANVAS_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          ok: false,
          status: response.status === 404 ? 404 : 503,
          message:
            response.status === 404
              ? "上游没有这块画布。"
              : `OpenDesign 返回 HTTP ${response.status}。`,
        };
      }
      return { ok: true, value: (await response.json()) as T };
    } catch {
      return { ok: false, status: 503, message: "OpenDesign 服务不可达。" };
    }
  };

  const readCanvas = async (
    base: string,
    projectId: string,
  ): Promise<
    | { ok: true; project: { projectId: string; name: string }; files: DaemonProjectFile[] }
    | { ok: false; status: number; message: string }
  > => {
    const [project, files] = await Promise.all([
      daemonJson<{ project?: { id?: string; name?: string } }>(
        base,
        `/api/projects/${encodeURIComponent(projectId)}`,
      ),
      daemonJson<{ files?: DaemonProjectFile[] }>(
        base,
        `/api/projects/${encodeURIComponent(projectId)}/files`,
      ),
    ]);
    if (!project.ok) return project;
    if (!files.ok) return files;
    return {
      ok: true,
      project: {
        projectId,
        name: project.value.project?.name ?? "未命名画布",
      },
      files: files.value.files ?? [],
    };
  };

  const resolvePreviewUrl = async (
    base: string,
    projectId: string,
    file: string,
  ): Promise<
    | { ok: true; url: string; iframeSandbox: string; opaqueOrigin: boolean }
    | { ok: false; status: number; message: string }
  > => {
    const resolved = await daemonJson<{
      url?: string;
      iframeSandbox?: string;
      opaqueOrigin?: boolean;
    }>(
      base,
      `/api/projects/${encodeURIComponent(projectId)}/preview-url?file=${encodeURIComponent(file)}`,
    );
    if (!resolved.ok) return resolved;
    if (!resolved.value.url) {
      return { ok: false, status: 503, message: "上游没有给出预览地址。" };
    }
    return {
      ok: true,
      url: resolved.value.url,
      iframeSandbox: resolved.value.iframeSandbox ?? "allow-scripts",
      opaqueOrigin: resolved.value.opaqueOrigin === true,
    };
  };

  // 新建画布（上游项目）：客户端自己起 id，与 agent 工具同一契约。
  app.post("/api/open-design/host/canvas", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    const base = canvasBaseUrl(reply);
    if (!base) return reply;
    const parsed = openDesignHostCreateCanvasRequestSchema.safeParse(
      request.body ?? {},
    );
    if (!parsed.success)
      return error(reply, 400, "application_error", "新建画布请求格式不正确。");
    const projectId = randomUUID();
    const name = parsed.data.name ?? "未命名画布";
    const created = await daemonJson<{ project?: { name?: string } }>(
      base,
      "/api/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: projectId, name }),
      },
    );
    if (!created.ok)
      return error(reply, created.status, "service_unavailable", created.message);
    const project = {
      projectId,
      name: created.value.project?.name ?? name,
    };
    // 用户新建的画布同样进「最近画布」：对话侧的能力上下文跟着走。
    if (options.dataDir)
      writeOpenDesignLastProject({
        dataDir: options.dataDir,
        project,
      });
    return reply.send(
      openDesignHostCanvasResponseSchema.parse({
        project,
        entryFile: null,
        files: [],
      }),
    );
  });

  // 读画布：项目名 + 文件表 + 入口文件（面板据此取标题与预览目标）。
  app.get("/api/open-design/host/canvas/:projectId", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    const base = canvasBaseUrl(reply);
    if (!base) return reply;
    const projectId = (request.params as { projectId?: string }).projectId?.trim();
    if (!projectId)
      return error(reply, 400, "application_error", "缺少画布 id。");
    const canvas = await readCanvas(base, projectId);
    if (!canvas.ok)
      return error(reply, canvas.status, "service_unavailable", canvas.message);
    return reply.send(
      openDesignHostCanvasResponseSchema.parse({
        project: canvas.project,
        entryFile: pickEntryFile(canvas.files),
        files: canvas.files
          .filter((file): file is { name: string } & DaemonProjectFile =>
            Boolean(file.name),
          )
          .map((file) => ({ name: file.name, kind: file.kind ?? "file" })),
      }),
    );
  });

  // 解析预览地址（iframe src + sandbox 原样透出）。
  app.get("/api/open-design/host/preview-url", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    const base = canvasBaseUrl(reply);
    if (!base) return reply;
    const query = request.query as { projectId?: string; file?: string };
    const projectId = query.projectId?.trim();
    const file = query.file?.trim();
    if (!projectId || !file)
      return error(reply, 400, "application_error", "缺少画布 id 或文件名。");
    const resolved = await resolvePreviewUrl(base, projectId, file);
    if (!resolved.ok)
      return error(reply, resolved.status, "service_unavailable", resolved.message);
    return reply.send(
      openDesignHostPreviewUrlResponseSchema.parse({
        url: resolved.url,
        iframeSandbox: resolved.iframeSandbox,
        opaqueOrigin: resolved.opaqueOrigin,
      }),
    );
  });

  // 设计文本：截图/导出在浏览器里做光栅化，输入是这份自包含 HTML。
  app.get("/api/open-design/host/file-text", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    const base = canvasBaseUrl(reply);
    if (!base) return reply;
    const query = request.query as { projectId?: string; file?: string };
    const projectId = query.projectId?.trim();
    const file = query.file?.trim();
    if (!projectId || !file)
      return error(reply, 400, "application_error", "缺少画布 id 或文件名。");
    const resolved = await resolvePreviewUrl(base, projectId, file);
    if (!resolved.ok)
      return error(reply, resolved.status, "service_unavailable", resolved.message);
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(`${base}${resolved.url}`, {
        signal: AbortSignal.timeout(OPEN_DESIGN_CANVAS_TIMEOUT_MS),
      });
      if (!response.ok) {
        return error(
          reply,
          response.status === 404 ? 404 : 503,
          "service_unavailable",
          `读取设计文件失败（HTTP ${response.status}）。`,
        );
      }
      const text = await response.text();
      if (text.length > OPEN_DESIGN_DESIGN_TEXT_MAX_LENGTH) {
        return error(
          reply,
          413,
          "application_error",
          "设计文件过大，暂不支持截图与导出。",
        );
      }
      return reply.send(
        openDesignHostFileTextResponseSchema.parse({ name: file, text }),
      );
    } catch {
      return error(reply, 503, "service_unavailable", "OpenDesign 服务不可达。");
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
