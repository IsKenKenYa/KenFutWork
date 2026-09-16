import type { FastifyInstance } from "fastify";

/**
 * Proxy endpoint for fetching external images server-side, bypassing browser CORS restrictions.
 * Used by the frontend to load generated images into Excalidraw canvas.
 */
export function registerImageProxyRoute(app: FastifyInstance) {
  // Build allowed domains list: static CDNs + dynamic Supabase host
  const staticAllowed = [
    "replicate.delivery",
    "replicate.com",
    "pbxt.replicate.delivery",
  ];

  /**
   * 额外允许的主机由 env 给出（`KENFUTWORK_IMAGE_PROXY_ALLOWED_HOSTS`，逗号分隔）。
   * 原实现从 `SUPABASE_URL` 推出允许主机——云托管已移除（M1.5），故改为显式配置：
   * 自托管可把自有对象存储/CDN 主机写进来，不必再依赖某个供应商的变量名。
   */
  const dynamicAllowed = (process.env.KENFUTWORK_IMAGE_PROXY_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

  const allowed = [...staticAllowed, ...dynamicAllowed];

  app.get<{
    Querystring: { url: string };
  }>("/api/proxy-image", async (request, reply) => {
    const { url } = request.query;

    if (!url || typeof url !== "string") {
      return reply.status(400).send({ error: "Missing url parameter" });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return reply.status(400).send({ error: "Invalid URL" });
    }

    if (!allowed.some((domain) => parsedUrl.hostname.endsWith(domain))) {
      return reply.status(403).send({ error: "Domain not allowed" });
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        return reply
          .status(response.status)
          .send({ error: "Upstream fetch failed" });
      }

      const contentType =
        response.headers.get("content-type") ?? "application/octet-stream";
      const buffer = Buffer.from(await response.arrayBuffer());

      return reply
        .header("content-type", contentType)
        .header("cache-control", "public, max-age=86400")
        .send(buffer);
    } catch {
      return reply.status(502).send({ error: "Failed to fetch image" });
    }
  });
}
