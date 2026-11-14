import type { FastifyInstance } from "fastify";

/**
 * Proxy endpoint for fetching external images server-side, bypassing browser CORS restrictions.
 * Used by the frontend to load generated images into Excalidraw canvas.
 */

// 重定向上限是本路由的协议行为常量（防跟跳循环），不进治理表。
const MAX_REDIRECT_HOPS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
  const dynamicAllowed = (
    process.env.KENFUTWORK_IMAGE_PROXY_ALLOWED_HOSTS ?? ""
  )
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

  const allowed = [...staticAllowed, ...dynamicAllowed];

  // 主机白名单必须带点边界：裸 `endsWith(domain)` 会放过 evil-replicate.delivery
  // 这类后缀巧合域，等于把白名单扩成「任何人注册个像样的域名就能用这个代理」。
  const isAllowedHost = (hostname: string) =>
    allowed.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );

  const isHttpUrl = (parsed: URL) =>
    parsed.protocol === "https:" || parsed.protocol === "http:";

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

    if (!isHttpUrl(parsedUrl) || !isAllowedHost(parsedUrl.hostname)) {
      return reply.status(403).send({ error: "Domain not allowed" });
    }

    // fetch 默认自动跟随重定向且不复查落点——白名单域 302 到内网/云元数据地址
    // 就是现成的 SSRF。改手动跟跳：每一跳都重新过协议与主机白名单。
    let current = parsedUrl;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const response = await fetch(current, { redirect: "manual" });
      const location = response.headers.get("location");

      if (REDIRECT_STATUSES.has(response.status) && location !== null) {
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return reply.status(502).send({ error: "Failed to fetch image" });
        }
        if (!isHttpUrl(next) || !isAllowedHost(next.hostname)) {
          return reply.status(403).send({ error: "Domain not allowed" });
        }
        current = next;
        continue;
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        return reply.status(502).send({ error: "Failed to fetch image" });
      }

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
    }

    return reply.status(502).send({ error: "Too many redirects" });
  });
}
