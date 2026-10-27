import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkEditorPinnedRelease } from "@kenfutwork/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { createConsumerLocalAccessService } from "../features/local-access/test-consumer-service.js";
import {
  getWorkEditorInstallSnapshot,
  startWorkEditorInstall,
} from "../features/work/install.js";
import {
  registerWorkHostRoutes,
  resolveInstalledEditors,
} from "./work-host.js";

const actor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: "work-host-client",
};
const apps: FastifyInstance[] = [];
const createdDirs: string[] = [];
const createdServers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    createdDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await Promise.all(
    createdServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

let currentEditorsDir = "";

async function emptyEditorsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "work-host-"));
  createdDirs.push(dir);
  return join(dir, "editors");
}

async function fixture(options: {
  authenticated?: boolean;
  editorsDir?: string;
  /** 替换 gridcraft 的锚定发布（假上游），路由级全链路不触真实网络。 */
  pinnedOverride?: WorkEditorPinnedRelease | null;
}) {
  currentEditorsDir = options.editorsDir ?? (await emptyEditorsDir());
  const app = Fastify();
  apps.push(app);
  await registerWorkHostRoutes(app, {
    localAccess: createConsumerLocalAccessService(async () =>
      options.authenticated === false ? null : actor,
    ),
    editors: {
      list: () =>
        resolveInstalledEditors({ editorsDir: currentEditorsDir }).map(
          (editor) =>
            options.pinnedOverride !== undefined && editor.id === "gridcraft"
              ? { ...editor, pinned: options.pinnedOverride }
              : editor,
        ),
    },
    dataDir: "/tmp/kenfutwork-data",
    editorsDir: currentEditorsDir,
  });
  return app;
}

/** 本地假上游：按需返回 zip 字节或错误；记录请求次数（幂等断言用）。 */
async function fakeUpstream(
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer(respond);
  createdServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/payload.zip`;
}

function pinnedFor(url: string, zip: Uint8Array): WorkEditorPinnedRelease {
  return {
    version: "0.11.1",
    asset: "gridcraft-web-0.11.1.zip",
    bytes: zip.length,
    sha256: createHash("sha256").update(zip).digest("hex"),
    url,
  };
}

/** 轮询到状态机离开 installing（异步下载/落位）；返回最终快照。 */
async function waitForSettled(editorId: string) {
  let snapshot = getWorkEditorInstallSnapshot(editorId);
  for (let i = 0; i < 200 && snapshot.state === "installing"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    snapshot = getWorkEditorInstallSnapshot(editorId);
  }
  return snapshot;
}

const encoder = new TextEncoder();
// fflate 的 zipSync 在 vitest 环境下对字符串值产出的包无法被 unzipSync 解析
// （fltn 递归爆栈），统一显式编码为 Uint8Array。
const zipOf = (files: Record<string, string | Uint8Array>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, content]) => [
        name,
        typeof content === "string" ? encoder.encode(content) : content,
      ]),
    ),
  );

describe("work 宿主路由", () => {
  it("status：本机接入 → enabled + 已登记数量 + 无原因（适配层自包含）", async () => {
    const app = await fixture({});
    const response = await app.inject({
      method: "get",
      path: "/api/work/host/status",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      enabled: true,
      registeredEditors: resolveInstalledEditors({
        editorsDir: currentEditorsDir,
      }).length,
      reasons: [],
    });
  });

  it("status：本机接入凭据缺失 → 401（unauthorized 错误形状，不裸抛）", async () => {
    const app = await fixture({ authenticated: false });
    const response = await app.inject({
      method: "get",
      path: "/api/work/host/status",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
  });

  it("editors：注册表全量返回 + dataDir + 安装快照；未落位时 installed 恒 false", async () => {
    const app = await fixture({});
    const response = await app.inject({
      method: "get",
      path: "/api/work/host/editors",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      editors: Array<{ id: string; installed: boolean; pinned: unknown }>;
      dataDir: string;
      install: Record<string, unknown>;
    };
    expect(body.dataDir).toBe("/tmp/kenfutwork-data");
    expect(body.editors.length).toBeGreaterThanOrEqual(10);
    expect(body.editors.every((editor) => editor.installed === false)).toBe(
      true,
    );
    expect(body.install).toEqual({});
    expect(
      body.editors.find((editor) => editor.id === "gridcraft")?.pinned,
    ).toMatchObject({ version: "0.11.1" });
    expect(
      body.editors.find((editor) => editor.id === "wordcraft")?.pinned,
    ).toMatchObject({ version: "0.11.0" });
    // 全部编辑器已锚定：不存在未锚定项（默认支持）
    expect(body.editors.every((editor) => editor.pinned !== null)).toBe(true);
  });

  it("安装：未锚定 → 400 可读原因（不摆假开关）；未知编辑器 → 404", async () => {
    // 注册表已全量锚定；400 分支用 fixture 注入 null pin（如未来新增未锚定项）保持护栏。
    const app = await fixture({ pinnedOverride: null });
    const unpinned = await app.inject({
      method: "post",
      path: "/api/work/host/editors/gridcraft/install",
    });
    expect(unpinned.statusCode).toBe(400);
    expect(unpinned.json().error.message).toContain("尚未锚定发布");
    const unknown = await app.inject({
      method: "post",
      path: "/api/work/host/editors/nope/install",
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("安装全链路：下载→校验→剥顶层目录落位→installed 翻转→再装幂等跳过（零下载）", async () => {
    const payload = zipOf({
      "gridcraft-web-0.11.1/index.html": "<html>gridcraft</html>",
      "gridcraft-web-0.11.1/gridcraft_bg.wasm": new Uint8Array([1, 2, 3]),
      "gridcraft-web-0.11.1/LICENSE-MIT": "MIT",
    });
    let requests = 0;
    const url = await fakeUpstream((req, res) => {
      requests += 1;
      res.writeHead(200, { "content-length": payload.length });
      res.end(req.url === "/payload.zip" ? payload : "");
    });
    const editorsDir = await emptyEditorsDir();
    const app = await fixture({
      editorsDir,
      pinnedOverride: pinnedFor(url, payload),
    });

    const start = await app.inject({
      method: "post",
      path: "/api/work/host/editors/gridcraft/install",
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().state).toBe("installing");

    const snapshot = await waitForSettled("gridcraft");
    expect(snapshot.state).toBe("ready");

    // 落位事实：剥顶层目录 + 标记 + installed 翻转
    expect(
      (await stat(join(editorsDir, "gridcraft", "index.html"))).isFile(),
    ).toBe(true);
    const marker = JSON.parse(
      await readFile(
        join(editorsDir, "gridcraft", ".kenfutwork-install.json"),
        "utf8",
      ),
    );
    expect(marker.version).toBe("0.11.1");
    const editors = await app.inject({
      method: "get",
      path: "/api/work/host/editors",
    });
    const gridcraft = (
      editors.json() as { editors: Array<{ id: string; installed: boolean }> }
    ).editors.find((editor) => editor.id === "gridcraft");
    expect(gridcraft?.installed).toBe(true);
    expect(
      (
        editors.json() as {
          install: Record<string, { state: string }>;
        }
      ).install.gridcraft?.state,
    ).toBe("ready");

    // 幂等：重装不下载、不破坏落位
    const again = await app.inject({
      method: "post",
      path: "/api/work/host/editors/gridcraft/install",
    });
    expect(again.statusCode).toBe(200);
    const after = await waitForSettled("gridcraft");
    expect(after.state).toBe("ready");
    expect(requests).toBe(1);
    expect(
      await readFile(join(editorsDir, "gridcraft", "index.html"), "utf8"),
    ).toBe("<html>gridcraft</html>");
  });

  it("校验和不匹配 → error 状态 + 可读原因，不落位", async () => {
    const payload = zipOf({ "gridcraft-web-0.11.1/index.html": "x" });
    const url = await fakeUpstream((req, res) => {
      res.end(req.url === "/payload.zip" ? payload : "");
    });
    const editorsDir = await emptyEditorsDir();
    await fixture({ editorsDir });
    const tampered: WorkEditorPinnedRelease = {
      ...pinnedFor(url, payload),
      sha256: "c".repeat(64),
    };
    startWorkEditorInstall({
      editorsDir,
      editorId: "gridcraft",
      pinned: tampered,
    });
    const snapshot = await waitForSettled("gridcraft");
    expect(snapshot.state).toBe("error");
    expect(snapshot.error).toContain("校验和不匹配");
    await expect(stat(join(editorsDir, "gridcraft"))).rejects.toThrow();
  });

  it("静态托管：MIME/nosniff/缓存头 + 点文件拒绝 + 路径穿越拒绝 + SPA 回落", async () => {
    const editorsDir = await emptyEditorsDir();
    const app = await fixture({ editorsDir });
    const editorDir = join(editorsDir, "gridcraft");
    await mkdir(editorDir, { recursive: true });
    await writeFile(join(editorDir, "index.html"), "<html>ok</html>");
    await writeFile(join(editorDir, "app_bg.wasm"), Buffer.from([0, 1, 2]));
    await writeFile(join(editorDir, ".kenfutwork-install.json"), "{}");
    await mkdir(join(editorDir, "assets"), { recursive: true });
    await writeFile(join(editorDir, "assets", "a.js"), "console.log(1)");

    const html = await app.inject({
      method: "get",
      path: "/api/work/host/editors/gridcraft/index.html",
    });
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(html.headers["x-content-type-options"]).toBe("nosniff");
    // HTML 注入语言 shim（上游自有字形只有拉丁/emoji，中文会变方框）；其余资产原样流式。
    expect(html.body).toContain('"en-US"');
    expect(html.body).toContain("<html>ok</html>");

    const wasm = await app.inject({
      method: "get",
      path: "/api/work/host/editors/gridcraft/app_bg.wasm",
    });
    expect(wasm.headers["content-type"]).toBe("application/wasm");
    expect(wasm.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );

    const js = await app.inject({
      method: "get",
      path: "/api/work/host/editors/gridcraft/assets/a.js",
    });
    expect(js.headers["content-type"]).toContain("text/javascript");

    // 无扩展名路径回落 index.html（上游站点唯一页面）
    const fallback = await app.inject({
      method: "get",
      path: "/api/work/host/editors/gridcraft/some/route",
    });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.body).toContain("<html>ok</html>");

    const dot = await app.inject({
      method: "get",
      path: "/api/work/host/editors/gridcraft/.kenfutwork-install.json",
    });
    expect(dot.statusCode).toBe(404);

    const traversal = await app.inject({
      method: "get",
      path: "/api/work/host/editors/gridcraft/..%2F..%2Fsecret.txt",
    });
    expect(traversal.statusCode).toBe(400);

    // 未落位的编辑器 404
    const missing = await app.inject({
      method: "get",
      path: "/api/work/host/editors/wordcraft/index.html",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toContain("尚未落位");
  });

  it("editors：扩展包目录落位 → installed=true，同前缀目录不误判（原 W1 事实保留）", async () => {
    const editorsDir = await emptyEditorsDir();
    await mkdir(join(editorsDir, "gridcraft"), { recursive: true });
    await mkdir(join(editorsDir, "gridcraftx"), { recursive: true });
    const app = await fixture({ editorsDir });
    const response = await app.inject({
      method: "get",
      path: "/api/work/host/editors",
    });
    const byId = new Map(
      (
        response.json() as {
          editors: Array<{ id: string; installed: boolean }>;
        }
      ).editors.map((editor) => [editor.id, editor.installed]),
    );
    expect(byId.get("gridcraft")).toBe(true);
    expect(byId.get("gridcraftx")).toBeUndefined();
    expect(byId.get("wordcraft")).toBe(false);
  });
});
