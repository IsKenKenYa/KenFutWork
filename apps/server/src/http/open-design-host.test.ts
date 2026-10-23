import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { LocalInstanceService } from "../features/local-instance/types.js";
import type { ResolvedInstanceCredentials } from "../features/model-providers/model-provider-service.js";
import { registerOpenDesignHostRoutes } from "./open-design-host.js";

/**
 * OpenDesign 宿主路由（O3 / OD-4 凭证下发）的端到端边界。
 *
 * 这条缝含明文 Key，所以每个入口都要钉死：
 * - 没配密钥 → 503（缝没开，不是「没有」）；
 * - 密钥错 → 401（timingSafeEqual，错一个字符都不行）；
 * - 协议版本错 → 400（版本协商不过就不下发）；
 * - 没有可用实例 → 404；Key 读不到 / 地址非法 → 409 且消息不含 Key 明文；
 * - 全部就绪 → 200 下发清单（明文 Key 是这条缝的目的，daemon 才拿得到）。
 */

const SECRET = "od-embed-secret";
const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";
const actor = {
  instanceId: "22222222-2222-4222-8222-222222222222",
  accessClientId: null,
};

const localInstance = {
  serviceActor: async () => actor,
} as unknown as LocalInstanceService;

function fixture(
  options: {
    secret?: string;
    configured?: boolean;
    baseUrl?: string;
    keyReadable?: boolean;
    authorized?: boolean;
  } = {},
) {
  const app = Fastify();
  const instance = {
    id: PROVIDER_ID,
    scope: "local" as const,
    name: "DeepSeek",
    protocol: "openai-compatible" as const,
    ...(options.baseUrl === null
      ? {}
      : { baseUrl: options.baseUrl ?? "https://api.deepseek.com" }),
    hasCredential: true,
    configRevision: 1,
    models: [],
    headerKeys: [],
    enabled: true,
  };
  const credentials: ResolvedInstanceCredentials = {
    instanceId: PROVIDER_ID,
    name: "DeepSeek",
    protocol: "openai-compatible",
    apiKey: "sk-byok-secret",
    baseUrl: options.baseUrl ?? "https://api.deepseek.com",
    configRevision: 1,
    models: [],
  };
  const listInstances = vi.fn(async () =>
    options.configured === false ? [] : [instance],
  );
  const resolveCredentialsById = vi.fn(async () => {
    if (options.keyReadable === false)
      throw new Error("凭据文件读取失败（不应把此消息透出）");
    return credentials;
  });
  void registerOpenDesignHostRoutes(app, {
    localAccess: {
      authenticate: async () => (options.authorized === false ? null : actor),
    },
    localInstance,
    providers: {
      listInstances,
      resolveCredentialsById,
    } as never,
    ...(options.secret === undefined ? {} : { secret: options.secret }),
  });
  return { app, listInstances, resolveCredentialsById };
}

const post = (app: Fastify.FastifyInstance, token?: string, version?: string) =>
  app.inject({
    method: "POST",
    url: "/api/open-design/host/credentials",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(version ? { "x-od-embed-protocol": version } : {}),
    },
    payload: {},
  });

describe("POST /api/open-design/host/credentials", () => {
  it("未配共享密钥 → 503 service_unavailable（缝没开，不说成「没有」）", async () => {
    const { app } = fixture();
    const response = await post(app, "whatever");
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("service_unavailable");
    expect(response.json().error.message).toContain(
      "KENFUTWORK_OPEN_DESIGN_EMBED_SECRET",
    );
  });

  it("密钥缺失 / 不匹配 → 401（错一个字符都不行）", async () => {
    const { app } = fixture({ secret: SECRET });
    const noToken = await post(app);
    expect(noToken.statusCode).toBe(401);
    const wrongToken = await post(app, `${SECRET}-x`);
    expect(wrongToken.statusCode).toBe(401);
  });

  it("密钥对但协议版本带错 → 400（版本协商不过就不下发）", async () => {
    const { app } = fixture({ secret: SECRET });
    const response = await post(app, SECRET, "v2");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("版本");
  });

  it("全部就绪 → 200 下发清单（明文 Key 是这条缝的目的）", async () => {
    const { app, resolveCredentialsById } = fixture({ secret: SECRET });
    const response = await post(app, SECRET);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      protocolVersion: "v1",
      credentials: [
        {
          providerId: PROVIDER_ID,
          name: "DeepSeek",
          protocol: "openai-compatible",
          apiBase: "https://api.deepseek.com",
          apiKey: "sk-byok-secret",
        },
      ],
    });
    expect(resolveCredentialsById).toHaveBeenCalledWith(PROVIDER_ID);
  });

  it("没有可用实例 → 404 open_design_not_configured", async () => {
    const { app } = fixture({ secret: SECRET, configured: false });
    const response = await post(app, SECRET);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("open_design_not_configured");
    expect(response.json().error.message).toContain("供应商设置");
  });

  it("Key 读不到 → 409 且失败消息不含 Key 明文 / 不含服务层错误细节", async () => {
    const { app } = fixture({ secret: SECRET, keyReadable: false });
    const response = await post(app, SECRET);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(
      "open_design_credential_unavailable",
    );
    expect(response.json().error.message).toContain("DeepSeek");
    expect(response.body).not.toContain("sk-byok-secret");
    expect(response.body).not.toContain("凭据文件读取失败");
  });

  it("地址非法 → 409 open_design_credential_unavailable", async () => {
    const { app } = fixture({
      secret: SECRET,
      baseUrl: "ftp://127.0.0.1:9000",
    });
    const response = await post(app, SECRET);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(
      "open_design_credential_unavailable",
    );
  });

  it("status 探针不受凭证缝影响：未接入 → 401；接入后如实 disabled", async () => {
    const denied = fixture({ secret: SECRET, authorized: false });
    const unauthorized = await denied.app.inject({
      method: "GET",
      url: "/api/open-design/host/status",
    });
    expect(unauthorized.statusCode).toBe(401);

    const { app } = fixture({ secret: SECRET });
    const authorized = await app.inject({
      method: "GET",
      url: "/api/open-design/host/status",
    });
    // localAccess 假实现恒过；未配 frontendUrl → 如实 disabled + 原因
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().enabled).toBe(false);
    expect(authorized.json().reasons.join("")).toContain("未配置");
  });
});

/**
 * 桌面承载配置读写（§205 设置页写入口）：本机接入门 + origin 校验 + 文件往返。
 */
describe("GET/PUT /api/open-design/host/config", () => {
  const configFixture = (
    options: { authorized?: boolean; withDir?: boolean } = {},
  ) => {
    const app = Fastify();
    const dataDir =
      options.withDir === false
        ? undefined
        : mkdtempSync(join(tmpdir(), "kfw-od-route-"));
    void registerOpenDesignHostRoutes(app, {
      localAccess: {
        authenticate: async () => (options.authorized === false ? null : actor),
      },
      localInstance,
      ...(dataDir ? { dataDir } : {}),
    });
    return { app, dataDir };
  };

  it("空目录 GET → 全空 + source=none；PUT 合法 origin 后 GET 回读（file + 待重启）", async () => {
    const { app, dataDir } = configFixture();
    const empty = await app.inject({
      method: "GET",
      url: "/api/open-design/host/config",
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({
      frontendUrl: null,
      embedSecret: null,
      restartRequired: false,
      source: "none",
    });

    const put = await app.inject({
      method: "PUT",
      url: "/api/open-design/host/config",
      payload: {
        frontendUrl: "http://127.0.0.1:7456",
        embedSecret: "paired-value",
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({
      frontendUrl: "http://127.0.0.1:7456",
      embedSecret: "paired-value",
      restartRequired: true,
      source: "file",
    });
    // 落盘的是 Tauri 认识的白名单文件格式
    const raw = readFileSync(
      join(dataDir!, "config", "open-design.env"),
      "utf8",
    );
    expect(raw).toContain(
      "KENFUTWORK_OPEN_DESIGN_FRONTEND_URL=http://127.0.0.1:7456",
    );
    expect(raw).toContain("KENFUTWORK_OPEN_DESIGN_EMBED_SECRET=paired-value");
  });

  it("origin 校验三拒：坏 URL / 带路径 / 非 http(s)——都不落盘", async () => {
    const { app, dataDir } = configFixture();
    for (const bad of [
      "not a url",
      "http://127.0.0.1:7456/some/path",
      "ftp://h/p",
    ]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/open-design/host/config",
        payload: { frontendUrl: bad },
      });
      expect(res.statusCode, bad).toBe(400);
    }
    expect(existsSync(join(dataDir!, "config", "open-design.env"))).toBe(false);
  });

  it("两键全 null → 清除文件内容（回到 none）", async () => {
    const { app } = configFixture();
    await app.inject({
      method: "PUT",
      url: "/api/open-design/host/config",
      payload: { frontendUrl: "http://localhost:7456", embedSecret: "x" },
    });
    const cleared = await app.inject({
      method: "PUT",
      url: "/api/open-design/host/config",
      payload: { frontendUrl: null, embedSecret: null },
    });
    expect(cleared.json()).toMatchObject({
      frontendUrl: null,
      embedSecret: null,
      source: "none",
    });
  });

  it("本机接入未授权 → GET/PUT 都 401；未配 dataDir → 路由不注册（404）", async () => {
    const denied = configFixture({ authorized: false });
    expect(
      (
        await denied.app.inject({
          method: "GET",
          url: "/api/open-design/host/config",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await denied.app.inject({
          method: "PUT",
          url: "/api/open-design/host/config",
          payload: {},
        })
      ).statusCode,
    ).toBe(401);

    const noDir = configFixture({ withDir: false });
    expect(
      (
        await noDir.app.inject({
          method: "GET",
          url: "/api/open-design/host/config",
        })
      ).statusCode,
    ).toBe(404);
  });
});

/**
 * 画布数据面（宿主代理）：面板不直连 daemon，读写都走这几条。
 * 契约：新建同时维护「最近画布」槽位；入口文件选取上游 artifactManifest 优先。
 */
function canvasFixture(
  options: {
    authorized?: boolean;
    frontendUrl?: string | undefined;
    dataDir?: string | undefined;
    fetchImpl?: typeof fetch;
    designReview?: {
      listByProject: (
        actor: unknown,
        projectId: string,
      ) => Promise<{
        comments: Array<{
          id: string;
          projectId: string;
          file: string;
          body: string;
          status: string;
          anchor: { path: string; rect: unknown; excerpt: string };
          createdAt: number;
          updatedAt: number;
        }>;
        annotations: Array<{
          id: string;
          projectId: string;
          file: string;
          kind: string;
          color: string;
          strokeWidth: number;
          points: Array<[number, number]>;
          createdAt: number;
          updatedAt: number;
        }>;
      }>;
    };
  } = {},
) {
  const app = Fastify();
  void registerOpenDesignHostRoutes(app, {
    localAccess: {
      authenticate: async () => (options.authorized === false ? null : actor),
    },
    ...(options.frontendUrl === undefined
      ? {}
      : { frontendUrl: options.frontendUrl }),
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
    ...(options.designReview === undefined
      ? {}
      : {
          designReview: options.designReview as never,
        }),
  });
  return app;
}

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

function daemonFetch(
  routes: Record<string, () => Response | Promise<Response>>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler();
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("画布数据面（/api/open-design/host/canvas 族）", () => {
  it("未授权 401；未配前端地址 400 open_design_not_configured", async () => {
    const denied = canvasFixture({
      authorized: false,
      frontendUrl: "http://x",
    });
    expect(
      (
        await denied.inject({
          method: "GET",
          url: "/api/open-design/host/canvas/p-1",
        })
      ).statusCode,
    ).toBe(401);

    const unconfigured = canvasFixture({ frontendUrl: undefined });
    const missing = await unconfigured.inject({
      method: "GET",
      url: "/api/open-design/host/canvas/p-1",
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("open_design_not_configured");
  });

  it("新建设计：透传默认名、回 projectId，并写「最近设计」槽位", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kfw-od-canvas-"));
    const calls: Array<{ url: string; body: string | null }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: (init?.body as string) ?? null });
      return jsonResponse({ project: { name: "未命名设计" } });
    }) as typeof fetch;
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456/",
      dataDir,
      fetchImpl,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/open-design/host/canvas",
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.project.projectId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(body.project.name).toBe("未命名设计");
    expect(body.entryFile).toBeNull();
    expect(calls[0]?.url).toBe("http://127.0.0.1:7456/api/projects");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      name: "未命名设计",
    });
    const slot = JSON.parse(
      readFileSync(
        join(dataDir, "config", "open-design-last-project.json"),
        "utf8",
      ),
    );
    expect(slot.projectId).toBe(body.project.projectId);
  });

  it("项目设计工作区：首开新建并绑定、二开复用、上游项目被删则重建", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kfw-od-workspace-"));
    let createdId: string | null = null;
    let alive = true;
    const createdNames: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/projects") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          id: string;
          name: string;
        };
        createdId = body.id;
        createdNames.push(body.name);
        return jsonResponse({ project: { id: body.id, name: body.name } });
      }
      if (createdId && alive && url.endsWith(`/api/projects/${createdId}`))
        return jsonResponse({ project: { id: createdId, name: "测试项目" } });
      if (
        createdId &&
        alive &&
        url.endsWith(`/api/projects/${createdId}/files`)
      )
        return jsonResponse({
          files: [{ name: "index.html", kind: "html" }],
        });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      dataDir,
      fetchImpl,
    });
    const payload = { workspaceKey: "proj-1", name: "测试项目" };

    const first = await app.inject({
      method: "POST",
      url: "/api/open-design/host/workspace-project",
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      created: true,
      project: { name: "测试项目" },
      entryFile: null,
      files: [],
    });
    expect(createdNames).toEqual(["测试项目"]);

    const second = await app.inject({
      method: "POST",
      url: "/api/open-design/host/workspace-project",
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      created: false,
      entryFile: "index.html",
      files: [{ name: "index.html", kind: "html" }],
    });
    expect(createdNames).toHaveLength(1);

    const binding = JSON.parse(
      readFileSync(
        join(dataDir, "config", "open-design-workspace-projects.json"),
        "utf8",
      ),
    );
    // 只存 workspaceKey 的哈希，不把目录/项目身份原样写进配置。
    expect(JSON.stringify(binding)).not.toContain("proj-1");

    alive = false;
    const third = await app.inject({
      method: "POST",
      url: "/api/open-design/host/workspace-project",
      payload,
    });
    expect(third.statusCode).toBe(200);
    expect(third.json().created).toBe(true);
    expect(createdNames).toHaveLength(2);
  });

  it("项目设计工作区：缺数据目录 → 503；缺 workspaceKey → 400", async () => {
    const noData = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: daemonFetch({}),
    });
    const missingData = await noData.inject({
      method: "POST",
      url: "/api/open-design/host/workspace-project",
      payload: { workspaceKey: "proj-1" },
    });
    expect(missingData.statusCode).toBe(503);
    expect(missingData.json().error.code).toBe("open_design_not_configured");

    const dataDir = mkdtempSync(join(tmpdir(), "kfw-od-workspace-bad-"));
    const withData = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      dataDir,
      fetchImpl: daemonFetch({}),
    });
    const bad = await withData.inject({
      method: "POST",
      url: "/api/open-design/host/workspace-project",
      payload: { workspaceKey: "" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("项目资源新建文档：写进已绑定项目并返回文件名", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const fetchImpl = daemonFetch({
      "/api/projects/p-1": () =>
        jsonResponse({ project: { id: "p-1", name: "测试项目" } }),
      "/api/projects/p-1/files": () => {
        // 读文件表与写文件共用同一路径：按调用无法区分，交给下面包装。
        return jsonResponse({ files: [] });
      },
    });
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          String(input).endsWith("/api/projects/p-1/files") &&
          init?.method === "POST"
        ) {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          writes.push(body);
          return jsonResponse({
            file: { name: body.name, kind: "document" },
          });
        }
        return fetchImpl(input, init);
      }) as typeof fetch,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/open-design/host/design-document",
      payload: { projectId: "p-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().file).toEqual({
      name: "未命名文档.md",
      kind: "document",
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      content: "# 未命名文档\n\n",
      versionSource: "manual",
      versionLabel: "新建文档",
    });
    expect(writes[0]?.name).toBe("未命名文档.md");
  });

  it("项目资源新建设计稿：写空白 HTML 并按序号去重", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const fetchImpl = daemonFetch({
      "/api/projects/p-1": () =>
        jsonResponse({ project: { id: "p-1", name: "测试项目" } }),
      "/api/projects/p-1/files": () =>
        jsonResponse({
          files: [{ name: "未命名设计.html", kind: "html" }],
        }),
    });
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          String(input).endsWith("/api/projects/p-1/files") &&
          init?.method === "POST"
        ) {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          writes.push(body);
          return jsonResponse({ file: { name: body.name, kind: "html" } });
        }
        return fetchImpl(input, init);
      }) as typeof fetch,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/open-design/host/design-file",
      payload: { projectId: "p-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().file).toEqual({
      name: "未命名设计-2.html",
      kind: "html",
    });
    expect(writes).toHaveLength(1);
    const content = String(writes[0]?.content ?? "");
    expect(content).toContain("<!doctype html>");
    expect(content).toContain("<main></main>");
    expect(content).toContain("<title>未命名设计</title>");
    expect(writes[0]).toMatchObject({
      versionSource: "manual",
      versionLabel: "新建设计稿",
    });
  });

  it("项目资源新建文档：上游项目不存在 → 404", async () => {
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: daemonFetch({}),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/open-design/host/design-document",
      payload: { projectId: "p-gone" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("读画布：入口文件按 artifactManifest 优先，退第一个 html，再退 null", async () => {
    const withManifest = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: daemonFetch({
        "/api/projects/p-1": () =>
          jsonResponse({ project: { id: "p-1", name: "订单页" } }),
        "/api/projects/p-1/files": () =>
          jsonResponse({
            files: [
              { name: "notes.md", kind: "markdown" },
              {
                name: "home.html",
                kind: "html",
                artifactManifest: { entry: "home.html" },
              },
              { name: "other.html", kind: "html" },
            ],
          }),
      }),
    });
    const declared = await withManifest.inject({
      method: "GET",
      url: "/api/open-design/host/canvas/p-1",
    });
    expect(declared.statusCode).toBe(200);
    expect(declared.json()).toMatchObject({
      project: { projectId: "p-1", name: "订单页" },
      entryFile: "home.html",
    });

    const fallback = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: daemonFetch({
        "/api/projects/p-2": () =>
          jsonResponse({ project: { id: "p-2", name: "空" } }),
        "/api/projects/p-2/files": () =>
          jsonResponse({ files: [{ name: "仅记.md", kind: "markdown" }] }),
      }),
    });
    const none = await fallback.inject({
      method: "GET",
      url: "/api/open-design/host/canvas/p-2",
    });
    expect(none.json().entryFile).toBeNull();
  });

  it("上游 404 → 404；上游不可达 → 503（都带可读消息）", async () => {
    const notFound = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: daemonFetch({}),
    });
    const missing = await notFound.inject({
      method: "GET",
      url: "/api/open-design/host/canvas/p-gone",
    });
    expect(missing.statusCode).toBe(404);

    const unreachable = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
    });
    const down = await unreachable.inject({
      method: "GET",
      url: "/api/open-design/host/canvas/p-1",
    });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.message).toContain("不可达");
  });

  it("预览地址：原样透出 url 与 sandbox；缺参数 400", async () => {
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: daemonFetch({
        "/preview-url?file=index.html": () =>
          jsonResponse({
            url: "/api/projects/p-1/preview/tok/index.html",
            iframeSandbox: "allow-scripts allow-forms",
            opaqueOrigin: true,
          }),
      }),
    });
    const ok = await app.inject({
      method: "GET",
      url: "/api/open-design/host/preview-url?projectId=p-1&file=index.html",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      url: "/api/projects/p-1/preview/tok/index.html",
      iframeSandbox: "allow-scripts allow-forms",
      opaqueOrigin: true,
    });

    const bad = await app.inject({
      method: "GET",
      url: "/api/open-design/host/preview-url?projectId=p-1",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("设计文本：取回 HTML；超过上限 413（截图输入有大小护栏）", async () => {
    const routes = {
      "/preview-url?file=index.html": () =>
        jsonResponse({ url: "/api/projects/p-1/preview/tok/index.html" }),
      "/preview/tok/index.html": () =>
        new Response("<html>hi</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    };
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: daemonFetch(routes),
    });
    const text = await app.inject({
      method: "GET",
      url: "/api/open-design/host/file-text?projectId=p-1&file=index.html",
    });
    expect(text.statusCode).toBe(200);
    expect(text.json()).toEqual({
      name: "index.html",
      text: "<html>hi</html>",
    });

    const huge = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: daemonFetch({
        ...routes,
        "/preview/tok/index.html": () =>
          new Response("a".repeat(2 * 1024 * 1024 + 1), {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      }),
    });
    const tooBig = await huge.inject({
      method: "GET",
      url: "/api/open-design/host/file-text?projectId=p-1&file=index.html",
    });
    expect(tooBig.statusCode).toBe(413);
  });
  it("版本历史：映射上游字段并过滤无 id 条目；正文按上限透出", async () => {
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: daemonFetch({
        "/files/index.html/versions/v-1": () =>
          jsonResponse({
            version: {
              id: "v-1",
              label: "Version 1",
              version: 1,
              createdAt: 1792477257537,
            },
            content: "<html>old</html>",
          }),
        "/files/index.html/versions": () =>
          jsonResponse({
            versions: [
              {
                id: "v-1",
                label: "Version 1",
                version: 1,
                createdAt: 1792477257537,
                size: 848,
                current: true,
              },
              { label: "no id" },
            ],
          }),
      }),
    });
    const list = await app.inject({
      method: "GET",
      url: "/api/open-design/host/versions?projectId=p-1&file=index.html",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().versions).toEqual([
      {
        id: "v-1",
        label: "Version 1",
        version: 1,
        createdAt: 1792477257537,
        size: 848,
        current: true,
      },
    ]);

    const content = await app.inject({
      method: "GET",
      url: "/api/open-design/host/version-content?projectId=p-1&file=index.html&versionId=v-1",
    });
    expect(content.statusCode).toBe(200);
    expect(content.json()).toEqual({
      version: {
        id: "v-1",
        label: "Version 1",
        version: 1,
        createdAt: 1792477257537,
      },
      text: "<html>old</html>",
    });

    const missing = await app.inject({
      method: "GET",
      url: "/api/open-design/host/version-content?projectId=p-1&file=index.html",
    });
    expect(missing.statusCode).toBe(400);
  });
});

describe("GET /api/open-design/host/projects", () => {
  it("按更新时间倒序、丢掉没有 id 的行；未授权 401", async () => {
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: daemonFetch({
        "/api/projects": () =>
          jsonResponse({
            projects: [
              { id: "p-old", name: "旧画布", updatedAt: 100 },
              { name: "缺 id" },
              { id: "p-new", name: "新画布", updatedAt: 300 },
              { id: "p-mid", updatedAt: 200 },
            ],
          }),
      }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/open-design/host/projects",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      projects: [
        { projectId: "p-new", name: "新画布", updatedAt: 300 },
        { projectId: "p-mid", name: "未命名设计", updatedAt: 200 },
        { projectId: "p-old", name: "旧画布", updatedAt: 100 },
      ],
    });

    const denied = canvasFixture({
      authorized: false,
      frontendUrl: "http://127.0.0.1:7456",
    });
    expect(
      (
        await denied.inject({
          method: "GET",
          url: "/api/open-design/host/projects",
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("POST /api/open-design/host/file", () => {
  /** 记录上游请求体的假 daemon：只挂写文件这一条。 */
  function writeFetch(reply: unknown) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return jsonResponse(reply);
    }) as typeof fetch;
    return {
      calls,
      app: canvasFixture({ frontendUrl: "http://127.0.0.1:7456", fetchImpl }),
    };
  }

  it("HTML 写入代记 manual 版本，并透出上游版本", async () => {
    const { calls, app } = writeFetch({
      file: { name: "index.html", kind: "html" },
      version: { id: "v-9", version: 9, label: "手动编辑" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/open-design/host/file",
      payload: {
        projectId: "p-1",
        name: "index.html",
        content: "<html>edited</html>",
        versionLabel: "手动编辑",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      file: { name: "index.html", kind: "html" },
      version: { id: "v-9", version: 9, label: "手动编辑" },
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:7456/api/projects/p-1/files");
    expect(calls[0]?.body).toEqual({
      name: "index.html",
      content: "<html>edited</html>",
      versionSource: "manual",
      versionLabel: "手动编辑",
    });
  });

  it("二进制资源走 base64 且不记版本", async () => {
    const { calls, app } = writeFetch({
      file: { name: "logo.png", kind: "image" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/open-design/host/file",
      payload: {
        projectId: "p-1",
        name: "assets/logo.png",
        content: "aGVsbG8=",
        encoding: "base64",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBeNull();
    expect(calls[0]?.body).toEqual({
      name: "assets/logo.png",
      content: "aGVsbG8=",
      encoding: "base64",
    });
  });

  it("拒绝上级目录与绝对路径；上游 404 透出可读原因", async () => {
    const traversal = writeFetch({ file: { name: "x", kind: "file" } });
    for (const name of [
      "../escape.html",
      "/etc/passwd",
      "C:\\Windows\\x.html",
    ]) {
      const response = await traversal.app.inject({
        method: "POST",
        url: "/api/open-design/host/file",
        payload: { projectId: "p-1", name, content: "x" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("文件名");
    }
    expect(traversal.calls).toHaveLength(0);

    const notFound = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: daemonFetch({}),
    });
    const missing = await notFound.inject({
      method: "POST",
      url: "/api/open-design/host/file",
      payload: { projectId: "p-404", name: "index.html", content: "x" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe("上游没有这块画布。");
  });
});

describe("POST /api/open-design/host/file-rename", () => {
  it("读旧正文、写新名、删旧文件", async () => {
    const calls: Array<{
      method: string;
      url: string;
      body?: Record<string, unknown>;
    }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/projects/p-1"))
        return jsonResponse({ project: { id: "p-1", name: "项目" } });
      if (url.endsWith("/api/projects/p-1/files") && method === "GET")
        return jsonResponse({
          files: [{ name: "notes.md", kind: "document" }],
        });
      if (url.endsWith("/api/projects/p-1/preview-url?file=notes.md"))
        return jsonResponse({
          url: "/preview/notes.md",
          iframeSandbox: "allow-scripts",
        });
      if (url.endsWith("/preview/notes.md"))
        return new Response("# 方案\n\n正文", {
          status: 200,
          headers: { "content-type": "text/markdown" },
        });
      if (method === "POST" && url.endsWith("/api/projects/p-1/files")) {
        calls.push({
          method,
          url,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return jsonResponse({
          file: { name: "方案说明.md", kind: "document" },
        });
      }
      if (method === "DELETE" && url.includes("/files/notes.md")) {
        calls.push({ method, url });
        return jsonResponse({ ok: true });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/open-design/host/file-rename",
      payload: {
        projectId: "p-1",
        name: "notes.md",
        newName: "方案说明.md",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().file).toEqual({
      name: "方案说明.md",
      kind: "document",
    });
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      name: "方案说明.md",
      content: "# 方案\n\n正文",
    });
    expect(
      calls.some(
        (call) =>
          call.method === "DELETE" && call.url.includes("/files/notes.md"),
      ),
    ).toBe(true);
  });

  it("同名冲突 409；路径/非文本 400", async () => {
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/projects/p-1"))
          return jsonResponse({ project: { id: "p-1", name: "项目" } });
        if (url.endsWith("/api/projects/p-1/files"))
          return jsonResponse({ files: [{ name: "a.md" }, { name: "b.md" }] });
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/open-design/host/file-rename",
      payload: { projectId: "p-1", name: "a.md", newName: "b.md" },
    });
    expect(conflict.statusCode).toBe(409);

    const traversal = await app.inject({
      method: "POST",
      url: "/api/open-design/host/file-rename",
      payload: { projectId: "p-1", name: "a.md", newName: "../x.md" },
    });
    expect(traversal.statusCode).toBe(400);

    const binary = await app.inject({
      method: "POST",
      url: "/api/open-design/host/file-rename",
      payload: { projectId: "p-1", name: "a.md", newName: "x.png" },
    });
    expect(binary.statusCode).toBe(400);
  });
});

describe("「同步到引擎」与文档/设计体系（PR-1 数据面）", () => {
  it("新建文档：建项目+写 document.md 起始稿（含受管段骨架），进最近画布", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kfw-od-doc-"));
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      dataDir,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        if (init?.method === "POST" && url.endsWith("/api/projects")) {
          writes.push({ url, body });
          return jsonResponse({ project: { name: "未命名文档" } });
        }
        if (init?.method === "POST" && url.endsWith("/files")) {
          writes.push({ url, body });
          return jsonResponse({
            file: { name: "document.md", kind: "markdown" },
          });
        }
        return jsonResponse({});
      }) as typeof fetch,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/open-design/host/document",
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const created = response.json() as { project: { projectId: string } };
    expect(writes).toHaveLength(2);
    const docWrite = writes[1]!.body as { name: string; content: string };
    expect(docWrite.name).toBe("document.md");
    expect(docWrite.content).toContain("<!-- kfw-sync:spec:start -->");
    expect(docWrite.content).toContain("<!-- kfw-sync:review:end -->");
    expect(
      JSON.parse(
        readFileSync(
          join(dataDir, "config", "open-design-last-project.json"),
          "utf8",
        ),
      ).projectId,
    ).toBe(created.project.projectId);
    await app.close();
  });

  it("context 同步：评论+标注聚进 document.md 受管段，标注 PNG 落 review/；段外内容不动", async () => {
    let existingDoc = "# 设计稿\n\n引擎写的正文不许动。\n";
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/preview-url"))
          return jsonResponse({ url: "/preview/token/document.md" });
        if (url.endsWith("/preview/token/document.md"))
          return new Response(existingDoc);
        if (init?.method === "POST" && url.endsWith("/files")) {
          writes.push({
            url,
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          });
          return jsonResponse({ file: { name: "x", kind: "file" } });
        }
        return jsonResponse({});
      }) as typeof fetch,
      designReview: {
        listByProject: async () => ({
          comments: [
            {
              id: "c1",
              projectId: "p-1",
              file: "index.html",
              body: "按钮太挤",
              status: "open",
              anchor: { path: "div>a.btn", rect: {}, excerpt: "立即购买" },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          annotations: [
            {
              id: "a1",
              projectId: "p-1",
              file: "index.html",
              kind: "pen",
              color: "#ff5701",
              strokeWidth: 3,
              points: [
                [0.1, 0.1],
                [0.2, 0.2],
              ],
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/open-design/host/context",
      payload: { projectId: "p-1", specMarkdown: "做个深色主题" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      sections: string[];
      comments: number;
      annotations: number;
      annotationFiles: string[];
    };
    expect(body.comments).toBe(1);
    expect(body.annotations).toBe(1);
    expect(body.sections).toEqual(["spec", "review"]);
    expect(body.annotationFiles[0]).toMatch(/^review\/annotations-\d+\.png$/);
    // 写了三份：标注 PNG（base64）+ document.md
    expect(writes).toHaveLength(2);
    const pngWrite = writes[0]!.body as { name: string; encoding: string };
    expect(pngWrite.name.startsWith("review/annotations-")).toBe(true);
    expect(pngWrite.encoding).toBe("base64");
    const docWrite = writes[1]!.body as { name: string; content: string };
    const doc = docWrite.content as string;
    expect(doc).toContain("引擎写的正文不许动。");
    expect(doc).toContain("做个深色主题");
    expect(doc).toContain("按钮太挤");
    expect(doc).toContain("![标注](review/annotations-");
    existingDoc = doc; // 幂等基线（下一次同步以本次产物为底）
    await app.close();
  });

  it("design-systems：代理清单收口 + bind 代理 PATCH designSystemId", async () => {
    const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/design-systems")) {
          return jsonResponse({
            designSystems: [
              {
                id: "agentic",
                title: "Agentic",
                category: "Themed",
                summary: "s",
                swatches: ["#ffffff", "#111827"],
              },
              { id: "", title: "坏的" },
            ],
          });
        }
        if (init?.method === "PATCH") {
          patches.push({
            url,
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          });
          return jsonResponse({ project: {} });
        }
        return jsonResponse({});
      }) as typeof fetch,
    });
    const listed = await app.inject({
      method: "GET",
      url: "/api/open-design/host/design-systems",
    });
    expect(listed.statusCode).toBe(200);
    const systems = (listed.json() as { designSystems: Array<{ id: string }> })
      .designSystems;
    expect(systems.map((s) => s.id)).toEqual(["agentic"]);

    const bound = await app.inject({
      method: "POST",
      url: "/api/open-design/host/design-systems/bind",
      payload: { projectId: "p-1", designSystemId: "agentic" },
    });
    expect(bound.statusCode).toBe(200);
    expect(patches[0]!.body.designSystemId).toBe("agentic");
    await app.close();
  });

  it("design-systems：新建设计体系走上游 /api/brands 提取并轮询状态", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/brands") && init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return jsonResponse({
            id: "brand-1",
            projectId: "brand-project-1",
            status: "extracting",
            designSystemId: "user:draft",
          });
        }
        if (url.endsWith("/api/brands/brand-1"))
          return jsonResponse({
            meta: {
              id: "brand-1",
              status: "ready",
              designSystemId: "user:new",
            },
            brand: { name: "新体系" },
          });
        if (url.endsWith("/api/brands/brand-failed"))
          return jsonResponse({
            meta: {
              id: "brand-failed",
              status: "failed",
              extractionTerminalError:
                "Programmatic extraction needs user assistance.",
              blocked: true,
            },
            brand: null,
          });
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/open-design/host/design-systems",
      payload: {
        url: "https://example.com",
        description: "面向设计师",
        designMd: "# 示例",
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      extraction: {
        id: "brand-1",
        status: "extracting",
        designSystemId: "user:draft",
        title: null,
        error: null,
      },
    });
    expect(posts).toEqual([
      {
        url: "https://example.com",
        description: "面向设计师",
        designMd: "# 示例",
        locale: "zh-CN",
      },
    ]);

    const polled = await app.inject({
      method: "GET",
      url: "/api/open-design/host/design-systems/extractions/brand-1",
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toEqual({
      extraction: {
        id: "brand-1",
        status: "ready",
        designSystemId: "user:new",
        title: "新体系",
        error: null,
      },
    });

    const failed = await app.inject({
      method: "GET",
      url: "/api/open-design/host/design-systems/extractions/brand-failed",
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().extraction).toMatchObject({
      status: "failed",
      designSystemId: null,
      error: "Programmatic extraction needs user assistance.",
    });

    const missing = await app.inject({
      method: "GET",
      url: "/api/open-design/host/design-systems/extractions/brand-missing",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe("没有这条提取任务。");

    const invalid = await app.inject({
      method: "POST",
      url: "/api/open-design/host/design-systems",
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.message).toBe("至少提供网站或 DESIGN.md。");

    const badUrl = await app.inject({
      method: "POST",
      url: "/api/open-design/host/design-systems",
      payload: { url: "ftp://example.com" },
    });
    expect(badUrl.statusCode).toBe(400);
    expect(badUrl.json().error.message).toBe("网站链接必须是 http(s) 地址。");
    expect(posts).toHaveLength(1);
    await app.close();
  });
});

describe("静态分享部署代理（Cloudflare Pages / Vercel）", () => {
  it("配置读：token 只回显掩码；配置写：代理 PUT 上游字段", async () => {
    const puts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/deploy/config") && init?.method !== "PUT") {
          return jsonResponse({
            configured: true,
            tokenMask: "****abcd",
            accountId: "acc-1",
          });
        }
        if (init?.method === "PUT" && url.includes("/api/deploy/config")) {
          puts.push({
            url,
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
          });
          return jsonResponse({ configured: true, tokenMask: "****abcd" });
        }
        return jsonResponse({});
      }) as typeof fetch,
    });
    const read = await app.inject({
      method: "GET",
      url: "/api/open-design/host/deploy/config?providerId=cloudflare-pages",
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { tokenMask: string }).tokenMask).toBe("****abcd");

    const written = await app.inject({
      method: "PUT",
      url: "/api/open-design/host/deploy/config",
      payload: { providerId: "vercel-self", token: "tok-1" },
    });
    expect(written.statusCode).toBe(200);
    expect(puts[0]!.body).toMatchObject({
      providerId: "vercel-self",
      token: "tok-1",
    });
    await app.close();
  });

  it("发布：缺省取入口 HTML 代理 deploy；失败如实回可读原因", async () => {
    const deployCalls: Array<Record<string, unknown>> = [];
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/projects/p-1/files")) {
          return jsonResponse({
            files: [{ name: "index.html", kind: "html" }],
          });
        }
        if (
          url.endsWith("/api/projects/p-1/deploy") &&
          init?.method === "POST"
        ) {
          deployCalls.push(
            JSON.parse(String(init.body)) as Record<string, unknown>,
          );
          return jsonResponse({
            id: "d-1",
            fileName: "index.html",
            providerId: "cloudflare-pages",
            url: "https://abc.pages.dev/",
            target: "production",
            status: "ready",
            createdAt: 1,
            updatedAt: 1,
          });
        }
        return jsonResponse({});
      }) as typeof fetch,
    });
    const deployed = await app.inject({
      method: "POST",
      url: "/api/open-design/host/deploy",
      payload: { projectId: "p-1", providerId: "cloudflare-pages" },
    });
    expect(deployed.statusCode).toBe(200);
    expect(deployCalls[0]).toMatchObject({
      fileName: "index.html",
      providerId: "cloudflare-pages",
    });
    expect((deployed.json() as { url: string }).url).toBe(
      "https://abc.pages.dev/",
    );

    const failing = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: daemonFetch({
        "/api/projects/p-1/files": () =>
          jsonResponse({ files: [{ name: "a.html" }] }),
        "/deploy": () =>
          jsonResponse(
            { error: { message: "Cloudflare API token is required." } },
            400,
          ),
      }),
    });
    const failed = await failing.inject({
      method: "POST",
      url: "/api/open-design/host/deploy",
      payload: { projectId: "p-1", providerId: "cloudflare-pages" },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error.message).toContain("token");
    await app.close();
    await failing.close();
  });
});

describe("保存到工作目录（引擎 → 我们）", () => {
  it("读画布入口文件写入工作目录；文件名清洗；目录不存在可读报错", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "kfw-od-ws-"));
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/projects/p-1/files")) {
          return jsonResponse({
            files: [{ name: "index.html", kind: "html" }],
          });
        }
        if (url.includes("/preview-url"))
          return jsonResponse({ url: "/preview/t/index.html" });
        if (url.endsWith("/preview/t/index.html"))
          return new Response("<html>design</html>");
        return jsonResponse({});
      }) as typeof fetch,
    });
    const saved = await app.inject({
      method: "POST",
      url: "/api/open-design/host/save-to-workspace",
      payload: { projectId: "p-1", workspacePath: workspace },
    });
    expect(saved.statusCode).toBe(200);
    const body = saved.json() as { path: string; bytes: number };
    expect(body.path).toBe(join(workspace, "index.html"));
    expect(readFileSync(body.path, "utf8")).toBe("<html>design</html>");

    const missingDir = await app.inject({
      method: "POST",
      url: "/api/open-design/host/save-to-workspace",
      payload: { projectId: "p-1", workspacePath: join(workspace, "nope") },
    });
    expect(missingDir.statusCode).toBe(400);
    expect(missingDir.json().error.message).toContain("工作目录");
    await app.close();
  });
});

describe("浏览器页面同步到画布（PR-4）", () => {
  it("截图落 browser/ + document.md 受管段置顶；无画布槽位可读报错", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kfw-od-bp-"));
    // 先写最近画布槽位
    const slotDir = join(dataDir, "config");
    mkdirSync(slotDir, { recursive: true });
    writeFileSync(
      join(slotDir, "open-design-last-project.json"),
      JSON.stringify({
        projectId: "p-9",
        name: "订单页",
        updatedAt: "2026-10-21T00:00:00.000Z",
      }),
    );
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    const app = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      dataDir,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/preview-url"))
          return jsonResponse({ url: "/preview/t/document.md" });
        if (url.endsWith("/preview/t/document.md"))
          return new Response(
            "# 设计\n\n<!-- kfw-sync:browser:start -->\n浏览过的页面\n- [旧页](https://old.example)\n<!-- kfw-sync:browser:end -->\n",
          );
        if (init?.method === "POST" && url.endsWith("/files")) {
          writes.push({
            url,
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
          });
          return jsonResponse({ file: { name: "x", kind: "file" } });
        }
        return jsonResponse({});
      }) as typeof fetch,
    });
    const synced = await app.inject({
      method: "POST",
      url: "/api/open-design/host/browser-page",
      payload: {
        url: "https://new.example",
        screenshotBase64: "AAAA",
        title: "新页",
      },
    });
    expect(synced.statusCode).toBe(200);
    const body = synced.json() as { screenshotFile: string | null };
    expect(body.screenshotFile).toMatch(/^browser\/page-\d+\.png$/);
    expect(writes).toHaveLength(2);
    const doc = writes[1]!.body as { content: string };
    expect(doc.content).toContain("https://new.example");
    expect(doc.content).toContain("https://old.example"); // 旧条目保留
    expect(doc.content.indexOf("new.example")).toBeLessThan(
      doc.content.indexOf("old.example"),
    ); // 置顶
    await app.close();

    const noSlot = canvasFixture({
      frontendUrl: "http://127.0.0.1:7456",
      dataDir: mkdtempSync(join(tmpdir(), "kfw-od-bp2-")),
      fetchImpl: daemonFetch({}),
    });
    const rejected = await noSlot.inject({
      method: "POST",
      url: "/api/open-design/host/browser-page",
      payload: { url: "https://x.example" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toContain("画布");
    await noSlot.close();
  });
});
