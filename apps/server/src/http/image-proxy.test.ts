import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerImageProxyRoute } from "./image-proxy.js";

const apps: FastifyInstance[] = [];
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("KENFUTWORK_IMAGE_PROXY_ALLOWED_HOSTS", "images.test,cdn.test");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

async function fixture() {
  const app = Fastify();
  registerImageProxyRoute(app);
  await app.ready();
  apps.push(app);
  return app;
}

const pngResponse = () =>
  new Response("png-bytes", {
    status: 200,
    headers: { "content-type": "image/png" },
  });

describe("GET /api/proxy-image", () => {
  it("白名单域直取：透传上游字节与 content-type", async () => {
    fetchMock.mockResolvedValue(pngResponse());
    const app = await fixture();

    const res = await app.inject({
      method: "GET",
      url: "/api/proxy-image",
      query: { url: "https://images.test/a.png" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("png-bytes");
    expect(res.headers["content-type"]).toBe("image/png");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("后缀巧合域拒绝：evil-replicate.delivery 不得命中 replicate.delivery", async () => {
    const app = await fixture();

    const res = await app.inject({
      method: "GET",
      url: "/api/proxy-image",
      query: { url: "https://evil-replicate.delivery/a.png" },
    });

    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("子域命中：a.images.test 允许", async () => {
    fetchMock.mockResolvedValue(pngResponse());
    const app = await fixture();

    const res = await app.inject({
      method: "GET",
      url: "/api/proxy-image",
      query: { url: "https://a.images.test/a.png" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("非 http(s) 协议拒绝", async () => {
    const app = await fixture();

    for (const url of [
      "data:text/html,hi",
      "ftp://images.test/a.png",
      "file:///etc/passwd",
    ]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/proxy-image",
        query: { url },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("缺 url 或坏 URL：400", async () => {
    const app = await fixture();

    expect(
      (await app.inject({ method: "GET", url: "/api/proxy-image" })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/proxy-image",
          query: { url: "not a url" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("重定向到白名单域：跟随并在新落点取回字节", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.test/b.png" },
        }),
      )
      .mockResolvedValueOnce(pngResponse());
    const app = await fixture();

    const res = await app.inject({
      method: "GET",
      url: "/api/proxy-image",
      query: { url: "https://images.test/r.png" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("png-bytes");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://cdn.test/b.png");
  });

  it("相对 location：按当前跳解析", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "/c.png" },
        }),
      )
      .mockResolvedValueOnce(pngResponse());
    const app = await fixture();

    const res = await app.inject({
      method: "GET",
      url: "/api/proxy-image",
      query: { url: "https://images.test/r.png" },
    });

    expect(res.statusCode).toBe(200);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://images.test/c.png",
    );
  });

  it("重定向到非白名单/内网地址：403 且不跟跳", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      }),
    );
    const app = await fixture();

    const res = await app.inject({
      method: "GET",
      url: "/api/proxy-image",
      query: { url: "https://images.test/r.png" },
    });

    expect(res.statusCode).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("重定向改协议为非 http(s)：403", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "data:text/html,hi" },
      }),
    );
    const app = await fixture();

    const res = await app.inject({
      method: "GET",
      url: "/api/proxy-image",
      query: { url: "https://images.test/r.png" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("重定向超上限：502", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://images.test/loop" },
        }),
      ),
    );
    const app = await fixture();

    const res = await app.inject({
      method: "GET",
      url: "/api/proxy-image",
      query: { url: "https://images.test/r.png" },
    });

    expect(res.statusCode).toBe(502);
  });

  it("无 location 的重定向：502", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302 }));
    const app = await fixture();

    const res = await app.inject({
      method: "GET",
      url: "/api/proxy-image",
      query: { url: "https://images.test/r.png" },
    });

    expect(res.statusCode).toBe(502);
  });

  it("上游非重定向失败：透传状态码", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    const app = await fixture();

    const res = await app.inject({
      method: "GET",
      url: "/api/proxy-image",
      query: { url: "https://images.test/gone.png" },
    });

    expect(res.statusCode).toBe(404);
  });
});
