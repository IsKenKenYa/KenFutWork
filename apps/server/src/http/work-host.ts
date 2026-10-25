import { createReadStream, existsSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
  type WorkEditor,
  type WorkHostEditorsResponse,
  type WorkHostStatusResponse,
  workEditorSchema,
  workHostEditorsResponseSchema,
  workHostStatusResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import {
  getWorkEditorInstallSnapshot,
  getWorkEditorInstallSnapshots,
  startWorkEditorInstall,
} from "../features/work/install.js";
import { listWorkEditorRegistrations } from "../features/work/registry.js";

/**
 * work 宿主适配层路由（`/api/work/host/*`）。
 *
 * 能力缝三元组（W2）：
 * - Service Definition：`packages/shared/src/work-host.ts`（探针 + 注册表 + 安装状态机形状）；
 * - Service Provider：本路由（注册表事实 + 安装状态机 + 编辑器静态托管）；
 * - Consumer：工作台 Work 模式入口门控、「Work 引擎」信息页与编辑器 iframe。
 *
 * 路由始终注册：status 是能力探针，如实回答启用状态与原因；编辑器 `installed`
 * 按数据目录落位事实计算；未锚定发布的编辑器不给下载（400，不摆假开关）。
 * 静态托管按上游 HOSTING.md 要求回 `.wasm` 的 `application/wasm` 与 nosniff。
 */
export async function registerWorkHostRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    editors: {
      /** 返回带落位事实的注册表（`installed` 按数据目录计算）。 */
      list(): WorkEditor[];
    };
    /** 扩展包数据目录（信息页如实展示；下载落位在这里）。 */
    dataDir: string;
    /** 扩展包落位根（= dataDir/work/editors；安装与托管共用）。 */
    editorsDir: string;
  },
): Promise<void> {
  const unauthorized = (reply: FastifyReply, message: string) =>
    reply.code(401).send(
      unauthenticatedErrorResponseSchema.parse({
        error: { code: "unauthorized", message },
      }),
    );
  const applicationError = (
    reply: FastifyReply,
    status: number,
    message: string,
  ) =>
    reply.code(status).send(
      applicationErrorResponseSchema.parse({
        error: { code: "application_error", message },
      }),
    );
  const requireLocalAccess = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if (await options.localAccess.authenticate(request)) return true;
    unauthorized(reply, "本机接入凭据缺失或无效。");
    return false;
  };
  const findEditor = (editorId: string): WorkEditor | undefined =>
    options.editors.list().find((editor) => editor.id === editorId);

  app.get("/api/work/host/status", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    const body: WorkHostStatusResponse = workHostStatusResponseSchema.parse({
      enabled: true,
      registeredEditors: options.editors.list().length,
      reasons: [],
    });
    return reply.send(body);
  });

  app.get("/api/work/host/editors", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    const body: WorkHostEditorsResponse = workHostEditorsResponseSchema.parse({
      editors: options.editors.list(),
      dataDir: options.dataDir,
      install: getWorkEditorInstallSnapshots(),
    });
    return reply.send(body);
  });

  app.post(
    "/api/work/host/editors/:editorId/install",
    async (request, reply) => {
      if (!(await requireLocalAccess(request, reply))) return;
      const editor = findEditor(
        String((request.params as { editorId: string }).editorId),
      );
      if (!editor) return applicationError(reply, 404, "没有这个编辑器。");
      if (!editor.pinned)
        return applicationError(
          reply,
          400,
          `${editor.title}尚未锚定发布，暂不提供下载。`,
        );
      const { started, snapshot } = startWorkEditorInstall({
        editorsDir: options.editorsDir,
        editorId: editor.id,
        pinned: editor.pinned,
      });
      if (!started)
        return applicationError(reply, 409, "安装已在进行中，请轮询状态。");
      return reply.send(snapshot);
    },
  );

  app.get(
    "/api/work/host/editors/:editorId/install/status",
    async (request, reply) => {
      if (!(await requireLocalAccess(request, reply))) return;
      const editorId = String(
        (request.params as { editorId: string }).editorId,
      );
      if (!findEditor(editorId))
        return applicationError(reply, 404, "没有这个编辑器。");
      return reply.send(getWorkEditorInstallSnapshot(editorId));
    },
  );

  // ---- 编辑器静态托管（WASM iframe 内嵌的承载面）----

  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
  };

  app.get("/api/work/host/editors/:editorId/*", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    const params = request.params as { editorId: string; "*": string };
    const editor = findEditor(params.editorId);
    if (!editor) return applicationError(reply, 404, "没有这个编辑器。");
    if (!editor.installed)
      return applicationError(
        reply,
        404,
        `${editor.title}尚未落位，请先下载。`,
      );

    let rel: string;
    try {
      rel = decodeURIComponent(params["*"] ?? "");
    } catch {
      return applicationError(reply, 400, "路径不合法。");
    }
    if (
      rel.length === 0 ||
      rel.startsWith("/") ||
      rel.startsWith("\\") ||
      rel.split(/[\\/]/).includes("..")
    )
      return applicationError(reply, 400, "路径不合法。");
    // 落位标记是安装器的内部事实，不对外提供。
    if (rel.split("/").some((segment) => segment.startsWith(".")))
      return applicationError(reply, 404, "没有这个文件。");

    const root = join(options.editorsDir, editor.id) + sep;
    let filePath = join(root, rel);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // 上游静态站点全部相对路径、index.html 是唯一页面：无扩展名的路径回落 index.html。
      if (!rel.includes(".")) filePath = join(root, "index.html");
      else return applicationError(reply, 404, "没有这个文件。");
    }
    if (!filePath.startsWith(root))
      return applicationError(reply, 400, "路径不合法。");

    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    reply
      .header("content-type", MIME[ext] ?? "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header(
        "cache-control",
        ext === ".wasm" || ext === ".js"
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
    return reply.send(createReadStream(filePath));
  });
}

/**
 * 计算注册表的落位事实：扩展包目录 `<editorsDir>/<id>` 存在即视为
 * 已落位（下载器以「目录完整 + 校验和标记」为口径，手动放置同目录即认）。
 */
export function resolveInstalledEditors(input: {
  editorsDir: string;
}): WorkEditor[] {
  return listWorkEditorRegistrations().map((registration) => {
    const installed = existsSync(join(input.editorsDir, registration.id));
    return workEditorSchema.parse({ ...registration, installed });
  });
}
