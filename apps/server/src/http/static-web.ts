import { createReadStream, existsSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * 静态 UI 托管（自托管/桌面包形态）：KENFUTWORK_WEB_DIST 指向 Next 静态导出目录时，
 * server 直接托管前端（单一入口，无需额外静态服务器）。
 * 解析顺序：精确文件 → `<path>.html`（Next 导出约定）→ 目录 index.html → 404.html。
 */

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isPrefix(parent: string, child: string): boolean {
  const rel = normalize(child).slice(parent.length);
  return normalize(child).startsWith(parent) && rel.startsWith(sep);
}

export function registerStaticWebRoutes(
  app: FastifyInstance,
  options: { distDir: string },
) {
  const distDir = normalize(options.distDir);
  if (
    !isAbsolute(distDir) ||
    !existsSync(distDir) ||
    !statSync(distDir).isDirectory()
  ) {
    throw new Error(
      `KENFUTWORK_WEB_DIST 目录无效：${options.distDir}（启动期 fail loud）`,
    );
  }

  const resolveFile = (urlPath: string): string | null => {
    const clean = normalize(decodeURIComponent(urlPath)).replace(/^[/\\]+/, "");
    const abs = join(distDir, clean);
    if (!isPrefix(distDir, abs)) return null; // 路径穿越防护
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
    const withHtml = `${abs}.html`;
    if (existsSync(withHtml) && statSync(withHtml).isFile()) return withHtml;
    const indexHtml = join(abs, "index.html");
    if (existsSync(indexHtml)) return indexHtml;
    return null;
  };

  const sendFile = (reply: FastifyReply, file: string, code = 200) => {
    const isHtml = extname(file) === ".html";
    // HTML 与品牌图必须 no-cache：WebView2 对 max-age 的图缓存一天且跨重装保留，
    // 换标后应用里一直渲染老图。两次真实事故：
    //   2026-09-20 favicon（exe 图标换了，任务栏还是老图）；
    //   2026-09-26 logo-mark（安装包与向导都已是新标，应用内侧栏/加载页还是旧裁边大图，
    //   用户看到「只有向导是对的」）。
    // 这些文件由 apps/desktop/scripts/icons.mjs 换标链统一重出：文件名稳定、内容会变，
    // 长缓存必然踩坑；no-cache 只是协商请求，图小量少，代价可忽略。其余照旧长缓存。
    const base = basename(file).toLowerCase();
    const noCache =
      isHtml ||
      base.startsWith("favicon.") ||
      base.startsWith("logo-mark.") ||
      base.startsWith("logo.") ||
      base.startsWith("app-icon.") ||
      base.startsWith("apple-touch-icon.");
    reply
      .code(code)
      .header(
        "content-type",
        MIME_TYPES[extname(file)] ?? "application/octet-stream",
      )
      .header("cache-control", noCache ? "no-cache" : "public, max-age=86400");
    return reply.send(createReadStream(file));
  };

  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? "/";
    const pathOnly = url.split("?")[0] ?? "/";
    const isApi = pathOnly === "/api" || pathOnly.startsWith("/api/");

    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(404).send({
        error: { code: "not_found", message: "Route not found." },
      });
    }
    if (isApi || !existsSync(join(distDir, "index.html"))) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Route not found." },
      });
    }

    const resolved =
      pathOnly === "/" ? join(distDir, "index.html") : resolveFile(pathOnly);
    if (resolved) return sendFile(reply, resolved);

    const notFoundHtml = join(distDir, "404.html");
    if (existsSync(notFoundHtml)) {
      return sendFile(reply, notFoundHtml, 404);
    }
    return reply.code(404).send({
      error: { code: "not_found", message: "Route not found." },
    });
  });
}
