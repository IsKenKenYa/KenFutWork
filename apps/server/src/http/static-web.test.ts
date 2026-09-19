import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerStaticWebRoutes } from "./static-web.js";

/**
 * 静态托管只测「缓存头」这一件事——它出过一次真实事故：
 * WebView2 拿**页面 favicon** 当窗口/任务栏图标，而 favicon 走的是 `max-age=86400`，
 * 于是换了图标要等一天才生效（2026-09-20：exe 的图标全换了，任务栏还是老图）。
 */
describe("静态 UI 托管：缓存头", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeDist(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "kfw-web-"));
    dirs.push(dir);
    await writeFile(join(dir, "index.html"), "<!doctype html><html></html>");
    await writeFile(join(dir, "favicon.png"), "png-bytes");
    await writeFile(join(dir, "app.js"), "console.log(1)");
    return dir;
  }

  it("favicon 走 no-cache，其余静态资源照旧长缓存", async () => {
    const app = Fastify();
    registerStaticWebRoutes(app, { distDir: await makeDist() });

    const favicon = await app.inject({ method: "GET", url: "/favicon.png" });
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers["cache-control"]).toBe("no-cache");

    const script = await app.inject({ method: "GET", url: "/app.js" });
    expect(script.statusCode).toBe(200);
    expect(script.headers["cache-control"]).toBe("public, max-age=86400");

    const html = await app.inject({ method: "GET", url: "/" });
    expect(html.headers["cache-control"]).toBe("no-cache");

    await app.close();
  });
});
