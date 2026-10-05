import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  AGENT_GOVERNANCE_LIMITS,
  workspaceSettingsSchema,
  resolveGovernanceEnvOverrides,
  resolveGovernanceNumber,
} from "@kenfutwork/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalConnectionUrl } from "./connection-url.js";
import { generateLocalAccessToken } from "./desktop-token.js";

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;
const healthy = {
  ok: true,
  service: "kenfutwork-server",
  version: "regression",
};
const ticketPayload = {
  ticket: "single-use-browser-ticket",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

describe("launcher本机连接：真实回环HTTP", () => {
  let dataDir: string;
  let servers: Server[];
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kfw-launcher-connection-"));
    await mkdir(join(dataDir, "local-access"));
    servers = [];
  });
  afterEach(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  async function listen(handler: Handler) {
    const server = createServer((request, response) => {
      void Promise.resolve()
        .then(() => handler(request, response))
        .catch((error: unknown) => {
          response.destroy(error instanceof Error ? error : undefined);
        });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("测试服务未分配回环端口。");
    return address.port;
  }

  function options(port: number, timeoutMs = 2_000, pollMs = 10) {
    return {
      env: {
        KENFUTWORK_DATA_DIR: dataDir,
        KENFUTWORK_LOCAL_SERVICE_STARTUP_TIMEOUT_MS: String(timeoutMs),
        KENFUTWORK_LOCAL_SERVICE_STARTUP_POLL_MS: String(pollMs),
      },
      port,
      uiBase: `http://localhost:${port}/workbench?mode=code`,
    };
  }

  async function writeToken(token = generateLocalAccessToken()) {
    await writeFile(join(dataDir, "local-access", "desktop-token"), token, {
      mode: 0o600,
    });
    return token;
  }

  it("冷启动未生成token时先等真实健康，健康后停止复核且只签一个票据", async () => {
    const token = generateLocalAccessToken();
    let healthCalls = 0;
    let ticketCalls = 0;
    const port = await listen(async (request, response) => {
      if (request.url === "/api/health") {
        healthCalls += 1;
        if (healthCalls < 3) return json(response, 503, { ok: false });
        await writeToken(token);
        return json(response, 200, healthy);
      }
      ticketCalls += 1;
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      json(response, 201, ticketPayload);
    });
    const connected = new URL(await createLocalConnectionUrl(options(port)));
    expect(connected.pathname).toBe("/workbench");
    expect(connected.searchParams.get("mode")).toBe("code");
    expect(new URLSearchParams(connected.hash.slice(1)).get("connect")).toBe(
      ticketPayload.ticket,
    );
    expect(connected.toString()).not.toContain(token);
    expect(healthCalls).toBe(3);
    expect(ticketCalls).toBe(1);
  });

  it("健康请求挂起会逐请求abort，复核不能重置总deadline，且从不尝试签票据", async () => {
    let healthCalls = 0;
    let ticketCalls = 0;
    let closes = 0;
    const port = await listen((request, response) => {
      if (request.url === "/api/health") {
        healthCalls += 1;
        response.on("close", () => {
          closes += 1;
        });
        return;
      }
      ticketCalls += 1;
      json(response, 500, {});
    });
    const started = performance.now();
    await expect(
      createLocalConnectionUrl(options(port, 200, 20)),
    ).rejects.toMatchObject({ code: "local_service_startup_timeout" });
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(healthCalls).toBeGreaterThan(1);
    expect(closes).toBeGreaterThan(0);
    expect(ticketCalls).toBe(0);
  });

  it("poll大于总预算时单次挂起请求也被绝对deadline截断", async () => {
    let healthCalls = 0;
    const port = await listen((_request, _response) => {
      healthCalls += 1;
    });
    const started = performance.now();
    await expect(
      createLocalConnectionUrl(options(port, 150, 1_000)),
    ).rejects.toMatchObject({ code: "local_service_startup_timeout" });
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(healthCalls).toBe(1);
  });

  it("健康就绪后缺失token立即报文件故障，不继续轮询或创建第二个凭据", async () => {
    let healthCalls = 0;
    let ticketCalls = 0;
    const port = await listen((request, response) => {
      if (request.url === "/api/health") {
        healthCalls += 1;
        return json(response, 200, healthy);
      }
      ticketCalls += 1;
      json(response, 201, ticketPayload);
    });
    await expect(createLocalConnectionUrl(options(port))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    expect(healthCalls).toBe(1);
    expect(ticketCalls).toBe(0);
  });

  it.each([401, 503])(
    "票据签发HTTP %s只尝试一次，不制造多票",
    async (status) => {
      await writeToken();
      let ticketCalls = 0;
      const port = await listen((request, response) => {
        if (request.url === "/api/health") return json(response, 200, healthy);
        ticketCalls += 1;
        json(response, status, { error: "rejected" });
      });
      await expect(createLocalConnectionUrl(options(port))).rejects.toThrow(
        `HTTP ${status}`,
      );
      expect(ticketCalls).toBe(1);
    },
  );

  it("票据响应正文挂起同样abort，失败后不能重新签发", async () => {
    await writeToken();
    let ticketCalls = 0;
    const port = await listen((request, response) => {
      if (request.url === "/api/health") return json(response, 200, healthy);
      ticketCalls += 1;
      response.writeHead(201, { "content-type": "application/json" });
      response.write('{"ticket":');
    });
    await expect(createLocalConnectionUrl(options(port, 200))).rejects.toThrow(
      "票据签发失败",
    );
    expect(ticketCalls).toBe(1);
  });

  it("HTTP200的其它服务不能被当成健康，凭据文件不会提前读取", async () => {
    let ticketCalls = 0;
    const port = await listen((request, response) => {
      if (request.url === "/api/health")
        return json(response, 200, { ...healthy, service: "other-service" });
      ticketCalls += 1;
      json(response, 201, ticketPayload);
    });
    await expect(
      createLocalConnectionUrl(options(port, 150)),
    ).rejects.toMatchObject({ code: "local_service_startup_timeout" });
    expect(ticketCalls).toBe(0);
  });

  it.each(["health", "ticket"])(
    "%s重定向被拒绝，不把请求或Bearer带到其它地址",
    async (phase) => {
      await writeToken();
      let forwarded = 0;
      let ticketCalls = 0;
      const trapPort = await listen((_request, response) => {
        forwarded += 1;
        json(response, 200, healthy);
      });
      const port = await listen((request, response) => {
        const healthRequest = request.url === "/api/health";
        if (!healthRequest) ticketCalls += 1;
        if (
          (phase === "health" && healthRequest) ||
          (phase === "ticket" && !healthRequest)
        ) {
          response.writeHead(307, {
            location: `http://127.0.0.1:${trapPort}/redirect-target`,
          });
          response.end();
        } else json(response, 200, healthy);
      });
      await expect(
        createLocalConnectionUrl(options(port, 150)),
      ).rejects.toThrow(phase === "health" ? "启动超时" : "票据签发失败");
      expect(forwarded).toBe(0);
      expect(ticketCalls).toBe(phase === "health" ? 0 : 1);
    },
  );

  it.each([
    "https://example.com/workbench",
    "http://127.0.0.1.example.com/",
    "http://user:secret@127.0.0.1/",
    "file:///tmp/workbench",
  ])("外部或带URL凭据的入口%s在任何健康请求前被拒绝", async (uiBase) => {
    let calls = 0;
    const port = await listen((_request, response) => {
      calls += 1;
      json(response, 200, healthy);
    });
    await expect(
      createLocalConnectionUrl({ ...options(port), uiBase }),
    ).rejects.toThrow("回环HTTP地址");
    expect(calls).toBe(0);
  });

  it("启动字段沿用唯一默认值、env解析和clamp；接通前不读库设置", () => {
    const settings = workspaceSettingsSchema.parse({
      defaultModel: "test-provider:model",
    });
    expect(settings.localServiceStartupTimeoutMs).toBe(
      AGENT_GOVERNANCE_DEFAULTS.localServiceStartupTimeoutMs,
    );
    expect(settings.localServiceStartupPollMs).toBe(
      AGENT_GOVERNANCE_DEFAULTS.localServiceStartupPollMs,
    );
    const overrides = resolveGovernanceEnvOverrides({
      KENFUTWORK_LOCAL_SERVICE_STARTUP_TIMEOUT_MS: "not-an-integer",
      KENFUTWORK_LOCAL_SERVICE_STARTUP_POLL_MS: "0",
    });
    expect(
      resolveGovernanceNumber(
        "localServiceStartupTimeoutMs",
        undefined,
        overrides,
      ),
    ).toBe(AGENT_GOVERNANCE_DEFAULTS.localServiceStartupTimeoutMs);
    expect(
      resolveGovernanceNumber(
        "localServiceStartupPollMs",
        undefined,
        overrides,
      ),
    ).toBe(AGENT_GOVERNANCE_LIMITS.localServiceStartupPollMs.min);
  });
});
