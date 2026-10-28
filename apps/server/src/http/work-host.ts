import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
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
  addFont,
  fontFormatOf,
  listFonts,
  MAX_FONT_BYTES,
  manifestFor,
  removeFont,
  workFontsDir,
} from "../features/work/fonts.js";
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

  // ---- 用户字体（Work 引擎页「字体」）----
  // 编辑器是 WASM 自绘、读不到系统字体：用户把 ttf/otf 放进实例数据目录，宿主在
  // 托管编辑器时映射到站点 `fonts/user/` 并生成 manifest，运行时加载字体的编辑器即可用。

  app.get("/api/work/host/fonts", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    return reply.send({
      dir: workFontsDir(options.dataDir),
      fonts: await listFonts(options.dataDir),
    });
  });

  app.post("/api/work/host/fonts", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    try {
      // 全局 multipart 上限是 10MB，但中文字体常超过它：这里按字体上限放行。
      const parts = request.parts({
        limits: { fileSize: MAX_FONT_BYTES, files: 1, fields: 0 },
      });
      let fileName: string | null = null;
      let bytes: Buffer | null = null;
      for await (const part of parts) {
        if (part.type !== "file") continue;
        if (bytes)
          return applicationError(reply, 400, "一次只能上传一个字体。");
        fileName = part.filename ?? null;
        bytes = await part.toBuffer();
      }
      if (!fileName || !bytes)
        return applicationError(reply, 400, "请选择一个字体文件。");
      const font = await addFont({
        dataDir: options.dataDir,
        fileName,
        bytes,
      });
      return reply.send({
        dir: workFontsDir(options.dataDir),
        fonts: await listFonts(options.dataDir),
        added: font,
      });
    } catch (error) {
      return applicationError(
        reply,
        400,
        error instanceof Error ? error.message : "字体上传失败。",
      );
    }
  });

  app.delete("/api/work/host/fonts/:fileName", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    const fileName = String((request.params as { fileName: string }).fileName);
    try {
      await removeFont(options.dataDir, fileName);
    } catch (error) {
      return applicationError(
        reply,
        400,
        error instanceof Error ? error.message : "删除失败。",
      );
    }
    return reply.send({
      dir: workFontsDir(options.dataDir),
      fonts: await listFonts(options.dataDir),
    });
  });

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

    // 用户字体：站点里的 `fonts/user/<文件名>` 与 `fonts/manifest.txt` 由宿主生成，
    // 不要求用户往每个编辑器目录里各放一份。编辑器包自带的 fonts/ 仍优先。
    const userFonts = workFontsDir(options.dataDir);
    if (rel.startsWith("fonts/user/")) {
      const name = rel.slice("fonts/user/".length);
      if (fontFormatOf(name) === null || /[/]/u.test(name))
        return applicationError(reply, 404, "没有这个文件。");
      const path = join(userFonts, name);
      if (!existsSync(path))
        return applicationError(reply, 404, "没有这个字体。");
      const fontMime = fontFormatOf(name) === "otf" ? "font/otf" : "font/ttf";
      return reply
        .header("content-type", fontMime)
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "no-cache")
        .send(createReadStream(path));
    }
    if (rel === "fonts/manifest.txt") {
      // 编辑器包自带的 fonts/ 仍要能加载（PhotoCraft 靠这份清单发现包内字形）：
      // 宿主生成的用户字体清单接在包内清单后面，而不是覆盖它。
      const bundledPath = join(options.editorsDir, editor.id, "fonts", "manifest.txt");
      const userManifest = manifestFor(await listFonts(options.dataDir));
      const bundled = existsSync(bundledPath)
        ? readFileSync(bundledPath, "utf8")
        : "";
      return reply
        .header("content-type", "text/plain; charset=utf-8")
        .header("cache-control", "no-cache")
        .send(`${bundled}${bundled && !bundled.endsWith("\n") ? "\n" : ""}${userManifest}`);
    }
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
    if (ext === ".html")
      return reply.send(
        injectEditorLocaleShim(readFileSync(filePath, "utf8"), editor.id),
      );
    return reply.send(createReadStream(filePath));
  });
}

/**
 * 上游编辑器（ArtCraft 系列）多数 web 包只内嵌拉丁/emoji 字形、**没有 CJK 字体**，
 * 却按 `navigator.language` 选中中文文案——界面于是整片方框（实测：同机 canvas 用
 * 系统字体画中文正常，编辑器自己是 WebGPU 自绘，不读浏览器字体，宿主注入 CSS 无效）。
 * 托管时把语言钉到 en-US：落到它自带字形能渲染的那套文案，比中文方框可读。
 *
 * 例外是自带中文字形的编辑器（`EDITOR_NATIVE_CJK`）：它们跟随浏览器语言即可正常显示
 * 中文，不钉英文——否则用户系统是中文也永远只能看英文界面。
 */
const EDITOR_LOCALE_SHIM = `<script>(function(){try{Object.defineProperty(Navigator.prototype,"language",{get:function(){return "en-US";}});Object.defineProperty(Navigator.prototype,"languages",{get:function(){return ["en-US","en"];}});}catch(error){}})();</script>`;

/**
 * 上游 web 包自带完整中文字形、可跟随浏览器语言的编辑器。
 * 2026-10-27 逐个实测（`navigator.language=zh-CN` 截图）：
 * - `lightcraft` 自带 `lightcraft_zh_hans.otf`，中文完整；
 * - `gridcraft` / `wordcraft` / `cadcraft` / `filmcraft` 用的是本仓自建的中文包
 *   （`scripts/build-work-editor-zh.mjs`：放开上游 web 的 CJK 白名单 + 内嵌 craft-fonts
 *   中文字形；WordCraft 另需 `CRAFT_I18N_DIR` 才有中文文案），实测菜单/面板整片中文；
 * - `vectorcraft` / `photocraft` 也换成了自建中文包（VectorCraft 走运行时 `fonts/<sha16>/`，
 *   PhotoCraft 由宿主在站点 `fonts/manifest.txt` 提供字体），实测整片中文；
 * - 其余上游 web 构建无中文字形或无中文文案，必须继续钉英文。
 *
 * 注意：这些编辑器的官方安装包仍是**英文版**；重新安装会覆盖自建包，装完需重跑构建脚本。
 */
const EDITOR_NATIVE_CJK = new Set([
  "lightcraft",
  "gridcraft",
  "wordcraft",
  "cadcraft",
  "filmcraft",
  "vectorcraft",
  "photocraft",
  "designcraft",
  "pdfcraft",
  "effectcraft",
  "deckcraft",
  "soundcraft",
]);

export function injectEditorLocaleShim(
  html: string,
  editorId?: string,
): string {
  if (editorId && EDITOR_NATIVE_CJK.has(editorId)) return html;
  const head = /<head[^>]*>/iu.exec(html);
  if (!head) return EDITOR_LOCALE_SHIM + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + EDITOR_LOCALE_SHIM + html.slice(at);
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
