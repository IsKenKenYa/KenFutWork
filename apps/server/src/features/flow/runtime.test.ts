import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFlowGatewayEnv,
  createFlowStackSupervisor,
  flowRuntimeDir,
  loadOrCreateFlowManagedConfig,
  resolveFlowDatabase,
  writeFlowRuntimeEnv,
} from "./runtime.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "flow-runtime-"));
}

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

describe("flow 本机运行配置", () => {
  it("首次生成后持久复用：密钥与端口不随重启变化", () => {
    const dataDir = tmp();
    const first = loadOrCreateFlowManagedConfig({ dataDir });
    const second = loadOrCreateFlowManagedConfig({ dataDir });
    expect(second).toEqual(first);
    expect(first.gatewayPort).toBe(15010);
    expect(first.frontendPort).toBe(8190);
    expect(first.sharedSecret).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.jwtSecret).toMatch(/^[0-9a-f]{64}$/u);
    const persisted = JSON.parse(
      readFileSync(join(flowRuntimeDir(dataDir), "flow-runtime.json"), "utf8"),
    ) as { sharedSecret: string };
    expect(persisted.sharedSecret).toBe(first.sharedSecret);
  });

  it("配置文件损坏：保留坏文件后重新生成，不阻塞启动", () => {
    const dataDir = tmp();
    mkdirSync(flowRuntimeDir(dataDir), { recursive: true });
    writeFileSync(
      join(flowRuntimeDir(dataDir), "flow-runtime.json"),
      "{坏的",
      "utf8",
    );
    const config = loadOrCreateFlowManagedConfig({ dataDir });
    expect(config.sharedSecret).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      readdirSync(flowRuntimeDir(dataDir)).some((name) =>
        name.startsWith("flow-runtime.json.corrupt-"),
      ),
    ).toBe(true);
  });

  it("应用库连接串改写成 flow 独立库，凭据保留", () => {
    expect(
      resolveFlowDatabase(
        "postgresql://kenfutwork:p%40ss@127.0.0.1:55433/kenfutwork",
      ),
    ).toEqual({
      host: "127.0.0.1",
      port: 55433,
      user: "kenfutwork",
      password: "p@ss",
      database: "futureflow",
    });
  });

  it("网关注入环境带齐宿主回调、共享密钥与前端来源", () => {
    const dataDir = tmp();
    const config = loadOrCreateFlowManagedConfig({ dataDir });
    const env = buildFlowGatewayEnv({
      config,
      dataDir,
      database: "postgresql://kenfutwork:secret@127.0.0.1:55433/kenfutwork",
      serverPort: 3001,
      webOrigin: "http://localhost:3000",
    });
    expect(env.HOST_MODE).toBe("embedded");
    expect(env.HOST_SHARED_SECRET).toBe(config.sharedSecret);
    expect(env.HOST_IDENTITY_VERIFY_URL).toBe(
      "http://127.0.0.1:3001/api/flow/host/identity",
    );
    expect(env.POSTGRES_DB).toBe("futureflow");
    expect(env.POSTGRES_PASSWORD).toBe("secret");
    expect(env.CORS_ORIGIN).toContain(
      `http://127.0.0.1:${config.frontendPort}`,
    );
    expect(env.DIFY_ADMIN_EMAIL).toBeTruthy();
    expect(env.DIFY_ADMIN_PASSWORD).toBeTruthy();
    const envFile = writeFlowRuntimeEnv(dataDir, env);
    expect(readFileSync(envFile, "utf8")).toContain(
      `HOST_SHARED_SECRET=${config.sharedSecret}`,
    );
  });
});

describe("flow 运行时托管", () => {
  it("网关已就绪且前端产物已构建：直接进入 ready，停止后回落 stopped", async () => {
    const dataDir = tmp();
    const flowDir = tmp();
    const gatewayPort = await freePort();
    const frontendPort = await freePort();
    loadOrCreateFlowManagedConfig({
      dataDir,
      preferredGatewayPort: gatewayPort,
      preferredFrontendPort: frontendPort,
    });
    mkdirSync(join(flowDir, "frontend", "dist"), { recursive: true });
    writeFileSync(
      join(flowDir, "frontend", "dist", "index.html"),
      "<html></html>",
    );
    writeFileSync(
      join(flowRuntimeDir(dataDir), "frontend-build.json"),
      JSON.stringify({ gatewayUrl: `http://127.0.0.1:${gatewayPort}` }),
    );
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
      if (url === `http://127.0.0.1:${frontendPort}/`)
        return new Response("ok", {
          status: 200,
          headers: { "x-kenfutwork-flow": "1" },
        });
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const supervisor = createFlowStackSupervisor({
      flowDir,
      dataDir,
      databaseUrl: "postgresql://kenfutwork:secret@127.0.0.1:55433/kenfutwork",
      serverPort: 3001,
      webOrigin: "http://localhost:3000",
      fetchImpl,
      ensureDatabaseImpl: async () => {},
      isPortFree: async () => true,
    });

    expect(supervisor.snapshot()).toMatchObject({
      state: "stopped",
      gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
      frontendUrl: `http://127.0.0.1:${frontendPort}`,
    });
    await supervisor.ensure();
    expect(supervisor.snapshot().state).toBe("ready");
    // 旧端口上的 Flow 前端是遗留监听：不能复用，必须由本进程在新端口启动，
    // 否则旧进程一退出，工作台就会打开一个空 iframe。
    const served = supervisor.snapshot().frontendUrl;
    expect(served).not.toBe(`http://127.0.0.1:${frontendPort}`);
    const response = await fetch(`${served}/`);
    expect(response.headers.get("x-kenfutwork-flow")).toBe("1");
    await response.body?.cancel();
    await supervisor.stop();
    expect(supervisor.snapshot().state).toBe("stopped");
  });

  it("建库失败：状态进入 error 并保留可读原因", async () => {
    const dataDir = tmp();
    const flowDir = tmp();
    const supervisor = createFlowStackSupervisor({
      flowDir,
      dataDir,
      databaseUrl: "postgresql://kenfutwork:secret@127.0.0.1:55433/kenfutwork",
      serverPort: 3001,
      webOrigin: "http://localhost:3000",
      fetchImpl: (async () =>
        new Response("down", { status: 503 })) as typeof fetch,
      ensureDatabaseImpl: async () => {
        throw new Error("应用库拒绝建库");
      },
      isPortFree: async () => true,
    });
    await supervisor.ensure();
    expect(supervisor.snapshot()).toMatchObject({
      state: "error",
      detail: "应用库拒绝建库",
    });
    expect(existsSync(flowRuntimeDir(dataDir))).toBe(true);
  });
});
