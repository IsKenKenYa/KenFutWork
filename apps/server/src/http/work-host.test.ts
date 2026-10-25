import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createConsumerLocalAccessService } from "../features/local-access/test-consumer-service.js";
import { registerWorkHostRoutes, resolveInstalledEditors } from "./work-host.js";

const actor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: "work-host-client",
};
const apps: FastifyInstance[] = [];
const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    createdDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(options: {
  authenticated?: boolean;
  editorsDir: string;
}) {
  const app = Fastify();
  apps.push(app);
  await registerWorkHostRoutes(app, {
    localAccess: createConsumerLocalAccessService(async () =>
      options.authenticated === false ? null : actor,
    ),
    editors: {
      list: () =>
        resolveInstalledEditors({ editorsDir: options.editorsDir }),
    },
    dataDir: "/tmp/kenfutwork-data",
  });
  return app;
}

describe("work 宿主路由", () => {
  it("status：本机接入 → enabled + 已登记数量 + 无原因（适配层自包含）", async () => {
    const editorsDir = await emptyEditorsDir();
    const app = await fixture({ editorsDir });
    const response = await app.inject({
      method: "get",
      path: "/api/work/host/status",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      enabled: true,
      registeredEditors: resolveInstalledEditors({ editorsDir }).length,
      reasons: [],
    });
  });

  it("status：本机接入凭据缺失 → 401（unauthorized 错误形状，不裸抛）", async () => {
    const app = await fixture({ authenticated: false, editorsDir: await emptyEditorsDir() });
    const response = await app.inject({
      method: "get",
      path: "/api/work/host/status",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
  });

  it("editors：注册表全量返回 + dataDir 透传；目录未落位时 installed 恒 false（不假装能装）", async () => {
    const editorsDir = await emptyEditorsDir();
    const app = await fixture({ editorsDir });
    const response = await app.inject({
      method: "get",
      path: "/api/work/host/editors",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      editors: Array<{ id: string; installed: boolean }>;
      dataDir: string;
    };
    expect(body.dataDir).toBe("/tmp/kenfutwork-data");
    expect(body.editors.length).toBeGreaterThanOrEqual(10);
    expect(body.editors.every((editor) => editor.installed === false)).toBe(
      true,
    );
  });

  it("editors：扩展包目录落位 → 该编辑器 installed=true，其余不受影响；同前缀目录不误判", async () => {
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

async function emptyEditorsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "work-host-"));
  createdDirs.push(dir);
  return join(dir, "editors");
}
