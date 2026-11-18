import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import type { LocalActor } from "../features/local-instance/types.js";
import type { NativeDirectoryPicker } from "../features/system/directory-picker.js";
import { createMemoryTaskWorkManager } from "../features/task-work/test-store.js";
import { createStartupPersistenceFixture } from "../test-startup-persistence.js";
import { registerSystemRoutes } from "./system.js";

/**
 * 原生目录对话框的 **HTTP 边界**（桌面形态「打开文件夹」的执行面）。
 *
 * 两条必须钉住的行为：
 * - 非桌面形态**绝不**去弹对话框（那会开在服务器那台机器的屏幕上）；直接报不可用 + 原因，
 *   且只说事实：不指路已移除的「填本机路径」入口；
 * - 四种结果按 `status` 分流回 200（取消不是错误，失败要带可读原因）。
 */

const ACTOR: LocalActor = {
  instanceId: "00000000-0000-4000-8000-000000000001",
  accessClientId: "00000000-0000-4000-8000-000000000009",
};

function buildRouteApp(options: {
  desktop: boolean | { available: boolean; reason?: string };
  picker: Partial<NativeDirectoryPicker>;
}) {
  const app = Fastify();
  registerSystemRoutes(app, {
    localAccess: {
      authenticate: async () => ACTOR,
    },
    picker: {
      availability: () => ({ available: true }),
      pick: async () => ({ status: "cancelled" }),
      ...options.picker,
    } as NativeDirectoryPicker,
    desktop: options.desktop,
  });
  return app;
}

describe("POST /api/system/pick-directory", () => {
  it("桌面形态 + 选中：回绝对路径", async () => {
    const app = buildRouteApp({
      desktop: true,
      picker: {
        pick: async () => ({ status: "picked", path: "D:\\Desktop\\test" }),
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/system/pick-directory",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "picked",
        path: "D:\\Desktop\\test",
      });
    } finally {
      await app.close();
    }
  });

  it("取消：仍是 200，且状态是 cancelled（客户端静默处理）", async () => {
    const app = buildRouteApp({
      desktop: true,
      picker: { pick: async () => ({ status: "cancelled" }) },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/system/pick-directory",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "cancelled" });
    } finally {
      await app.close();
    }
  });

  it("非桌面形态：不弹对话框，回 unavailable + 原因", async () => {
    const pick = vi.fn(async () => ({ status: "picked" as const, path: "/x" }));
    const app = buildRouteApp({
      desktop: { available: false, reason: "服务端在另一台机器上。" },
      picker: { pick },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/system/pick-directory",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "unavailable",
        reason: "服务端在另一台机器上。",
      });
      expect(pick).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("对话框执行失败：原样透出原因（截断的风险在挑选器里已收）", async () => {
    const app = buildRouteApp({
      desktop: true,
      picker: {
        pick: async () => ({
          status: "failed",
          reason: "退出码 3：cannot open display",
        }),
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/system/pick-directory",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "failed",
        reason: "退出码 3：cannot open display",
      });
    } finally {
      await app.close();
    }
  });

  it("未获得本机接入授权：401（不泄露任何形态信息）", async () => {
    const app = Fastify();
    registerSystemRoutes(app, {
      localAccess: {
        authenticate: async () => null,
      },
      picker: createStubPicker(),
      desktop: true,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/system/pick-directory",
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/system/directory-picker（能力探测）", () => {
  it("非桌面形态：available=false + 原因", async () => {
    const app = buildRouteApp({
      desktop: { available: false, reason: "当前不是桌面形态。" },
      picker: {},
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/system/directory-picker",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        available: false,
        reason: "当前不是桌面形态。",
      });
    } finally {
      await app.close();
    }
  });

  it("桌面形态：available=true", async () => {
    const app = buildRouteApp({ desktop: true, picker: {} });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/system/directory-picker",
      });
      expect(response.json()).toEqual({ available: true });
    } finally {
      await app.close();
    }
  });
});

/** 真装配下的接线检查：system 插件要真的把路由挂上，且按形态给出可用性。 */
describe("system 插件接线", () => {
  const boot = async (env: Record<string, unknown>) => {
    const persistence = createStartupPersistenceFixture();
    const app = buildApp({
      env: {
        databaseUrl: "postgres://localhost:5432/loenfut-test",
        blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
        desktopDataDir: persistence.dataDir,
        ...env,
      },
      overrides: {
        taskWork: createMemoryTaskWorkManager(),
        persistence,
      },
    });
    await app.ready();
    const token = await app.kernel.get("localAccess").getDesktopToken();
    return { app, headers: { authorization: `Bearer ${token}` } };
  };

  it("服务端形态（自托管）：路由在，探测报不可用并指路「填本机路径」", async () => {
    const { app, headers } = await boot({});
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/system/directory-picker",
        headers,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { available: boolean; reason?: string };
      expect(body.available).toBe(false);
      expect(body.reason).toBe("非桌面形态：系统文件夹对话框开不到你面前");
      // 「填本机路径」入口已按用户口径从界面移除，再指路等于让人去找不存在的东西
      expect(body.reason).not.toContain("填本机路径");
    } finally {
      await app.close();
    }
  });

  it("桌面形态（内嵌 Postgres）：探测报可用", async () => {
    const { app, headers } = await boot({ embeddedPostgres: true });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/system/directory-picker",
        headers,
      });
      expect(response.json()).toEqual({ available: true });
    } finally {
      await app.close();
    }
  });
});

function createStubPicker(): NativeDirectoryPicker {
  return {
    availability: () => ({ available: true }),
    pick: async () => ({ status: "cancelled" }),
  };
}
