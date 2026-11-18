import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, it } from "vitest";
import { registerImageProxyRoute } from "./image-proxy.js";

const apps: FastifyInstance[] = [];
const originalHosts = process.env.KENFUTWORK_IMAGE_PROXY_ALLOWED_HOSTS;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (originalHosts === undefined) {
    delete process.env.KENFUTWORK_IMAGE_PROXY_ALLOWED_HOSTS;
  } else {
    process.env.KENFUTWORK_IMAGE_PROXY_ALLOWED_HOSTS = originalHosts;
  }
});

async function fixture() {
  const requests: string[] = [];
  const upstream = Fastify();
  upstream.get("/*", async (request, reply) => {
    requests.push(request.url);
    const location = new URL(request.url, "http://localhost").searchParams.get(
      "next",
    );
    if (location !== null) return reply.redirect(location);
    if (request.url === "/loop") return reply.redirect("/loop");
    if (request.url === "/missing-location") return reply.status(302).send();
    if (request.url === "/missing") return reply.status(404).send();
    return reply.type("image/png").send(Buffer.from("png-bytes"));
  });
  apps.push(upstream);
  await upstream.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${(upstream.server.address() as AddressInfo).port}`;
  process.env.KENFUTWORK_IMAGE_PROXY_ALLOWED_HOSTS = "127.0.0.1";
  const proxy = Fastify();
  apps.push(proxy);
  registerImageProxyRoute(proxy);
  await proxy.ready();
  const fetchImage = (url: string) =>
    proxy.inject({ method: "GET", url: "/api/proxy-image", query: { url } });
  return { origin, requests, proxy, fetchImage };
}

it("真实上游图片及允许的相对和绝对重定向正常返回", async () => {
  const { origin, requests, fetchImage } = await fixture();
  for (const target of ["/image", `${origin}/image`]) {
    const response = await fetchImage(
      `${origin}/redirect?next=${encodeURIComponent(target)}`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("png-bytes");
    expect(response.headers["content-type"]).toBe("image/png");
  }
  expect(requests.filter((path) => path === "/image")).toHaveLength(2);
});

it("拒绝直接访问非白名单主机、后缀巧合、凭据伪装和非法协议", async () => {
  const { origin, requests, fetchImage } = await fixture();
  for (const target of [
    "http://localhost/private",
    "http://169.254.169.254/latest/meta-data",
    "https://evil-replicate.delivery/image",
    "https://replicate.delivery.attacker.invalid/image",
    "https://replicate.delivery@attacker.invalid/image",
    "ftp://replicate.delivery/image",
    "data:text/html,hello",
    "file:///etc/passwd",
  ]) {
    expect((await fetchImage(target)).statusCode).toBe(403);
  }
  expect(requests).toEqual([]);
  expect((await fetchImage(`${origin}/image`)).statusCode).toBe(200);
  expect(requests).toEqual(["/image"]);
});

it("逐跳拒绝非白名单地址且不对禁止的目标发起请求", async () => {
  const { origin, requests, fetchImage } = await fixture();
  const blocked = `${origin.replace("127.0.0.1", "localhost")}/private`;
  for (const target of [
    blocked,
    "http://169.254.169.254/latest/meta-data",
    "data:text/html,hello",
  ]) {
    const response = await fetchImage(
      `${origin}/redirect?next=${encodeURIComponent(target)}`,
    );
    expect(response.statusCode).toBe(403);
  }
  expect(requests).toHaveLength(3);
  expect(requests.every((path) => path.startsWith("/redirect?next="))).toBe(
    true,
  );
});

it("真实重定向循环、缺少 location 和上游失败按预期终止", async () => {
  const { origin, requests, fetchImage, proxy } = await fixture();
  expect((await fetchImage(`${origin}/loop`)).statusCode).toBe(502);
  expect(requests).toEqual(["/loop", "/loop", "/loop", "/loop"]);
  expect((await fetchImage(`${origin}/missing-location`)).statusCode).toBe(502);
  expect((await fetchImage(`${origin}/missing`)).statusCode).toBe(404);
  expect((await fetchImage("invalid-url")).statusCode).toBe(400);
  expect((await proxy.inject("/api/proxy-image")).statusCode).toBe(400);
});
