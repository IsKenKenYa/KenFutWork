import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  OPEN_DESIGN_HOST_TEXT_MAX_LENGTH,
  OPEN_DESIGN_SYNC_SECTION_REVIEW,
  OPEN_DESIGN_SYNC_SECTION_SPEC,
  openDesignHostBindDesignSystemRequestSchema,
  openDesignHostCanvasResponseSchema,
  openDesignHostConfigResponseSchema,
  openDesignHostConfigUpdateSchema,
  openDesignHostCreateCanvasRequestSchema,
  openDesignHostCreateDocumentRequestSchema,
  openDesignHostCredentialsRequestSchema,
  openDesignHostCredentialsResponseSchema,
  openDesignHostDesignSystemsResponseSchema,
  openDesignHostFileTextResponseSchema,
  openDesignHostLastProjectResponseSchema,
  openDesignHostPreviewUrlResponseSchema,
  openDesignHostProjectsResponseSchema,
  openDesignHostProvisionResponseSchema,
  openDesignHostStatusResponseSchema,
  openDesignHostSyncContextRequestSchema,
  openDesignHostSyncContextResponseSchema,
  openDesignHostVersionContentResponseSchema,
  openDesignHostVersionsResponseSchema,
  openDesignHostWriteFileRequestSchema,
  openDesignHostWriteFileResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { renderAnnotationsPng } from "../features/design-review/annotation-png.js";
import type { DesignReviewService } from "../features/design-review/design-review-service.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type { LocalActor } from "../features/local-instance/types.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type { OpenDesignCompanionSnapshot } from "../features/open-design/companion.js";
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
import {
  readOpenDesignLastProject,
  writeOpenDesignLastProject,
} from "../features/open-design/last-project.js";
import { provisionOpenDesign } from "../features/open-design/provision.js";
import { authorizeOpenDesignGateway } from "./open-design-gateway-auth.js";

/**
 * 画布数据面的本机守护进程调用上限。一次性局部常量（本地 companion 的 HTTP 读，
 * 不是 agent 治理数值），不进 `packages/shared/src/governance.ts`。
 */
const OPEN_DESIGN_CANVAS_TIMEOUT_MS = 5_000;

/**
 * 设计文本上限（读写同一口径，属主在 `@kenfutwork/shared`）：超限的页面不做
 * 截图/导出，也写不回去，一律如实报错。
 */
const OPEN_DESIGN_DESIGN_TEXT_MAX_LENGTH = OPEN_DESIGN_HOST_TEXT_MAX_LENGTH;

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

/** 上游只对 `.html`/`.htm` 记版本，宿主按同一口径判断。 */
function isHtmlDesignFile(name: string): boolean {
  return /\.html?$/iu.test(name);
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
    /** 评论/标注服务（「同步到引擎」聚合；缺省 = context 路由不注册）。 */
    designReview?: Pick<DesignReviewService, "listByProject"> | undefined;
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
    | {
        ok: true;
        project: { projectId: string; name: string };
        files: DaemonProjectFile[];
      }
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
      return error(
        reply,
        created.status,
        "service_unavailable",
        created.message,
      );
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

  /**
   * 新建文档画布（空态「新建文档」）：建项目 + 写入 document.md 起始稿
   * （spec/review 两个受管段骨架）。引擎以 document.md 为 spec 入口——
   * 这条路让「先写文档、再让引擎出设计」成立。
   */
  app.post("/api/open-design/host/document", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    const base = canvasBaseUrl(reply);
    if (!base) return reply;
    const parsed = openDesignHostCreateDocumentRequestSchema.safeParse(
      request.body ?? {},
    );
    if (!parsed.success)
      return error(reply, 400, "application_error", "新建文档请求格式不正确。");
    const projectId = randomUUID();
    const name = parsed.data.name ?? "未命名文档";
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
      return error(
        reply,
        created.status,
        "service_unavailable",
        created.message,
      );
    const project = {
      projectId,
      name: created.value.project?.name ?? name,
    };
    const starter = [
      `# ${project.name}`,
      "",
      "<!-- kfw-sync:spec:start -->",
      "在这里写给设计引擎的要求（或用「同步到引擎」把评审带进来）。",
      "<!-- kfw-sync:spec:end -->",
      "",
      "<!-- kfw-sync:review:start -->",
      "<!-- kfw-sync:review:end -->",
      "",
    ].join("\n");
    const written = await daemonJson(
      base,
      `/api/projects/${encodeURIComponent(projectId)}/files`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "document.md",
          content: starter,
          versionSource: "manual",
          versionLabel: "新建文档",
        }),
      },
    );
    if (!written.ok)
      return error(
        reply,
        written.status,
        "service_unavailable",
        `项目建好了，但文档没写进去：${written.message}`,
      );
    if (options.dataDir)
      writeOpenDesignLastProject({ dataDir: options.dataDir, project });
    return reply.send(
      openDesignHostCanvasResponseSchema.parse({
        project,
        entryFile: null,
        files: [],
      }),
    );
  });

  /**
   * 「同步到引擎」（我们 → 引擎）：把本仓的评论与标注聚合进项目 document.md 的
   * 受管段（成对 `<!-- kfw-sync:… -->` 标记，整段替换、段外内容一律不动），
   * 标注笔迹渲染成 PNG 落 `review/` 并在受管段里引用。可选 specMarkdown 整段
   * 替换 spec 受管段（对话侧计划文档走这条）。
   */
  app.post("/api/open-design/host/context", async (request, reply) => {
    const actor = await options.localAccess.authenticate(request);
    if (!actor) return unauthorized(reply, "本机接入凭据缺失或无效。");
    const base = canvasBaseUrl(reply);
    if (!base) return reply;
    const parsed = openDesignHostSyncContextRequestSchema.safeParse(
      request.body ?? {},
    );
    if (!parsed.success)
      return error(reply, 400, "application_error", "同步请求格式不正确。");
    const { projectId, specMarkdown } = parsed.data;
    if (!options.designReview)
      return error(reply, 503, "application_error", "评审数据面未接线。");
    const review = await options.designReview.listByProject(actor, projectId);

    // 1) 标注 → PNG（review/annotations-<ts>.png）
    const annotationFiles: string[] = [];
    if (review.annotations.length > 0) {
      const png = renderAnnotationsPng(review.annotations);
      const name = `review/annotations-${Date.now()}.png`;
      const uploaded = await daemonJson(
        base,
        `/api/projects/${encodeURIComponent(projectId)}/files`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            content: png.toString("base64"),
            encoding: "base64",
          }),
        },
      );
      if (!uploaded.ok)
        return error(
          reply,
          uploaded.status,
          "service_unavailable",
          `标注图没写进画布：${uploaded.message}`,
        );
      annotationFiles.push(name);
    }

    // 2) 组评审段
    const sections: Array<"spec" | "review"> = [];
    const reviewLines: string[] = [];
    if (review.comments.length > 0) {
      reviewLines.push("### 评审意见");
      for (const [index, comment] of review.comments.entries()) {
        const status = comment.status === "resolved" ? "已解决" : "待处理";
        const excerpt = comment.anchor.excerpt
          ? `（页面元素：${comment.anchor.excerpt.slice(0, 60)}）`
          : "";
        reviewLines.push(
          `${index + 1}. [${comment.file}] ${status} — ${comment.body}${excerpt}`,
        );
      }
    }
    if (annotationFiles.length > 0) {
      reviewLines.push("### 标注");
      for (const name of annotationFiles) {
        reviewLines.push(`![标注](${name})`);
      }
    }

    // 3) 读现有 document.md → 受管段替换 → 写回（没有则新建）
    const fetchImpl = options.fetchImpl ?? fetch;
    let existing = "";
    const resolved = await resolvePreviewUrl(base, projectId, "document.md");
    if (resolved.ok) {
      const response = await fetchImpl(`${base}${resolved.url}`, {
        signal: AbortSignal.timeout(OPEN_DESIGN_CANVAS_TIMEOUT_MS),
      }).catch(() => null);
      if (response?.ok) existing = await response.text();
    }
    const mergeManaged = (
      document: string,
      sectionId: string,
      content: string,
    ): string => {
      const start = `<!-- ${sectionId}:start -->`;
      const end = `<!-- ${sectionId}:end -->`;
      const block = `${start}\n${content}\n${end}`;
      const startIndex = document.indexOf(start);
      const endIndex = document.indexOf(end);
      if (startIndex >= 0 && endIndex > startIndex) {
        return (
          document.slice(0, startIndex) +
          block +
          document.slice(endIndex + end.length)
        );
      }
      return `${document.trimEnd()}\n\n${block}\n`;
    };
    let document = existing;
    if (typeof specMarkdown === "string") {
      document = mergeManaged(
        document,
        OPEN_DESIGN_SYNC_SECTION_SPEC,
        specMarkdown,
      );
      sections.push("spec");
    }
    if (reviewLines.length > 0) {
      document = mergeManaged(
        document,
        OPEN_DESIGN_SYNC_SECTION_REVIEW,
        reviewLines.join("\n"),
      );
      sections.push("review");
    }
    if (sections.length === 0)
      return error(
        reply,
        400,
        "application_error",
        "没有可同步的内容（没有评论与标注，也没带计划文档）。",
      );
    const written = await daemonJson(
      base,
      `/api/projects/${encodeURIComponent(projectId)}/files`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "document.md",
          content: document,
          versionSource: "manual",
          versionLabel: "同步评审",
        }),
      },
    );
    if (!written.ok)
      return error(
        reply,
        written.status,
        "service_unavailable",
        `document.md 没写进画布：${written.message}`,
      );
    return reply.send(
      openDesignHostSyncContextResponseSchema.parse({
        document: { name: "document.md" },
        sections,
        comments: review.comments.length,
        annotations: review.annotations.length,
        annotationFiles,
      }),
    );
  });

  /** 设计体系清单（上游 /api/design-systems 的宿主代理；空态「新建设计体系」）。 */
  app.get("/api/open-design/host/design-systems", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    const base = canvasBaseUrl(reply);
    if (!base) return reply;
    const listed = await daemonJson<{
      designSystems?: Array<{
        id?: unknown;
        title?: unknown;
        category?: unknown;
        summary?: unknown;
        swatches?: unknown;
      }>;
    }>(base, "/api/design-systems");
    if (!listed.ok)
      return error(reply, listed.status, "service_unavailable", listed.message);
    const designSystems = (listed.value.designSystems ?? [])
      .filter(
        (
          item,
        ): item is {
          id: string;
          title?: unknown;
          category?: unknown;
          summary?: unknown;
          swatches?: unknown;
        } => typeof item.id === "string" && item.id.length > 0,
      )
      .map((item) => ({
        id: item.id,
        title:
          typeof item.title === "string" && item.title ? item.title : item.id,
        category:
          typeof item.category === "string" && item.category
            ? item.category
            : null,
        summary:
          typeof item.summary === "string" && item.summary
            ? item.summary
            : null,
        swatches: Array.isArray(item.swatches)
          ? item.swatches.filter(
              (swatch): swatch is string => typeof swatch === "string",
            )
          : [],
      }));
    return reply.send(
      openDesignHostDesignSystemsResponseSchema.parse({ designSystems }),
    );
  });

  /** 绑定/切换画布的设计体系（代理上游 PATCH /api/projects/:id）。 */
  app.post(
    "/api/open-design/host/design-systems/bind",
    async (request, reply) => {
      if (!(await options.localAccess.authenticate(request)))
        return unauthorized(reply, "本机接入凭据缺失或无效。");
      const base = canvasBaseUrl(reply);
      if (!base) return reply;
      const parsed = openDesignHostBindDesignSystemRequestSchema.safeParse(
        request.body ?? {},
      );
      if (!parsed.success)
        return error(
          reply,
          400,
          "application_error",
          "绑定设计体系请求格式不正确。",
        );
      const { projectId, designSystemId } = parsed.data;
      const patched = await daemonJson(
        base,
        `/api/projects/${encodeURIComponent(projectId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ designSystemId }),
        },
      );
      if (!patched.ok)
        return error(
          reply,
          patched.status,
          "service_unavailable",
          `设计体系没绑上：${patched.message}`,
        );
      return reply.send({ ok: true });
    },
  );

  /**
   * 画布列表（面板「+」的「打开画布」项）：上游 project 概要按更新时间倒序。
   * 上游返回 `projects`，字段名是 `id`/`name`/`updatedAt`——宿主侧收口成自己的契约，
   * 面板不跟着上游改名。
   */
  app.get("/api/open-design/host/projects", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    const base = canvasBaseUrl(reply);
    if (!base) return reply;
    const listed = await daemonJson<{
      projects?: Array<{ id?: string; name?: string; updatedAt?: number }>;
    }>(base, "/api/projects");
    if (!listed.ok)
      return error(reply, listed.status, "service_unavailable", listed.message);
    const projects = (listed.value.projects ?? [])
      .filter(
        (
          project,
        ): project is { id: string; name?: string; updatedAt?: number } =>
          typeof project.id === "string" && project.id.length > 0,
      )
      .map((project) => ({
        projectId: project.id,
        name: project.name ?? "未命名画布",
        updatedAt: project.updatedAt ?? 0,
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 200);
    return reply.send(openDesignHostProjectsResponseSchema.parse({ projects }));
  });

  // 读画布：项目名 + 文件表 + 入口文件（面板据此取标题与预览目标）。
  app.get("/api/open-design/host/canvas/:projectId", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    const base = canvasBaseUrl(reply);
    if (!base) return reply;
    const projectId = (
      request.params as { projectId?: string }
    ).projectId?.trim();
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
      return error(
        reply,
        resolved.status,
        "service_unavailable",
        resolved.message,
      );
    return reply.send(
      openDesignHostPreviewUrlResponseSchema.parse({
        url: resolved.url,
        iframeSandbox: resolved.iframeSandbox,
        opaqueOrigin: resolved.opaqueOrigin,
      }),
    );
  });

  // 版本历史（列表 + 单个版本正文）：面板的「历史记录」数据面。
  app.get("/api/open-design/host/versions", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    const base = canvasBaseUrl(reply);
    if (!base) return reply;
    const query = request.query as { projectId?: string; file?: string };
    const projectId = query.projectId?.trim();
    const file = query.file?.trim();
    if (!projectId || !file)
      return error(reply, 400, "application_error", "缺少画布 id 或文件名。");
    const listed = await daemonJson<{
      versions?: Array<{
        id?: string;
        label?: string;
        version?: number;
        createdAt?: number;
        size?: number;
        current?: boolean;
      }>;
    }>(
      base,
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file)}/versions`,
    );
    if (!listed.ok)
      return error(reply, listed.status, "service_unavailable", listed.message);
    const versions = (listed.value.versions ?? [])
      .filter((version) => typeof version.id === "string" && version.id)
      .map((version) => ({
        id: version.id as string,
        label: version.label ?? `Version ${version.version ?? ""}`,
        version: version.version ?? 0,
        createdAt: version.createdAt ?? 0,
        size: version.size ?? 0,
        current: version.current === true,
      }));
    return reply.send(openDesignHostVersionsResponseSchema.parse({ versions }));
  });

  app.get("/api/open-design/host/version-content", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    const base = canvasBaseUrl(reply);
    if (!base) return reply;
    const query = request.query as {
      projectId?: string;
      file?: string;
      versionId?: string;
    };
    const projectId = query.projectId?.trim();
    const file = query.file?.trim();
    const versionId = query.versionId?.trim();
    if (!projectId || !file || !versionId)
      return error(
        reply,
        400,
        "application_error",
        "缺少画布 id、文件名或版本 id。",
      );
    const version = await daemonJson<{
      version?: {
        id?: string;
        label?: string;
        version?: number;
        createdAt?: number;
      };
      content?: string;
    }>(
      base,
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file)}/versions/${encodeURIComponent(versionId)}`,
    );
    if (!version.ok)
      return error(
        reply,
        version.status,
        "service_unavailable",
        version.message,
      );
    if (typeof version.value.content !== "string") {
      return error(reply, 503, "service_unavailable", "上游没有返回版本正文。");
    }
    if (version.value.content.length > OPEN_DESIGN_DESIGN_TEXT_MAX_LENGTH) {
      return error(
        reply,
        413,
        "application_error",
        "版本文件过大，暂不支持预览。",
      );
    }
    return reply.send(
      openDesignHostVersionContentResponseSchema.parse({
        version: {
          id: version.value.version?.id ?? versionId,
          label: version.value.version?.label ?? versionId,
          version: version.value.version?.version ?? 0,
          createdAt: version.value.version?.createdAt ?? 0,
        },
        text: version.value.content,
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
      return error(
        reply,
        resolved.status,
        "service_unavailable",
        resolved.message,
      );
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
      return error(
        reply,
        503,
        "service_unavailable",
        "OpenDesign 服务不可达。",
      );
    }
  });

  /**
   * 写入画布文件（可视化编辑保存、上传资源）。
   *
   * HTML 一律带 `versionSource: manual`：上游据此把这次手改记进**同一条**版本历史，
   * 面板的「历史记录」自然看得见，不需要宿主另建一套账。二进制资源走 base64。
   */
  app.post("/api/open-design/host/file", async (request, reply) => {
    if (!(await options.localAccess.authenticate(request)))
      return unauthorized(reply, "本机接入凭据缺失或无效。");
    const base = canvasBaseUrl(reply);
    if (!base) return reply;
    const parsed = openDesignHostWriteFileRequestSchema.safeParse(
      request.body ?? {},
    );
    if (!parsed.success)
      return error(reply, 400, "application_error", "写入文件请求格式不正确。");
    const { projectId, name, content, encoding, versionLabel } = parsed.data;
    if (
      name.startsWith("/") ||
      /^[a-zA-Z]:[\\/]/u.test(name) ||
      name.split(/[\\/]/u).includes("..")
    ) {
      return error(
        reply,
        400,
        "application_error",
        "文件名不能带绝对路径或上级目录。",
      );
    }
    const isHtml = isHtmlDesignFile(name);
    const written = await daemonJson<{
      file?: { name?: string; kind?: string };
      version?: { id?: string; version?: number; label?: string };
    }>(base, `/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        content,
        ...(encoding && encoding !== "utf8" ? { encoding } : {}),
        ...(isHtml ? { versionSource: "manual" } : {}),
        ...(versionLabel && isHtml ? { versionLabel } : {}),
      }),
    });
    if (!written.ok)
      return error(
        reply,
        written.status,
        "service_unavailable",
        written.message,
      );
    const version = written.value.version;
    return reply.send(
      openDesignHostWriteFileResponseSchema.parse({
        file: {
          name: written.value.file?.name ?? name,
          kind: written.value.file?.kind ?? (isHtml ? "html" : "file"),
        },
        version:
          typeof version?.id === "string" && version.id
            ? {
                id: version.id,
                version: version.version ?? 0,
                label: version.label ?? version.id,
              }
            : null,
      }),
    );
  });

  if (options.dataDir) {
    const dataDir = options.dataDir;
    // 右侧面板读「最近创建的项目」，据此把 iframe 定位到 /projects/<id>。
    app.get("/api/open-design/last-project", async (request, reply) => {
      if (!(await options.localAccess.authenticate(request)))
        return unauthorized(reply, "本机接入凭据缺失或无效。");
      return reply.send(
        openDesignHostLastProjectResponseSchema.parse({
          project: readOpenDesignLastProject({ dataDir }),
        }),
      );
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
    return reply.send(openDesignHostProvisionResponseSchema.parse(result));
  });
}
