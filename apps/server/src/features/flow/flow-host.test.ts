import { providerInstanceResponseSchema, type StreamEvent } from "@kenfutwork/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerFlowHostRoutes } from "../../http/flow-host.js";
import { CanvasEventBuffer, flowEventScopeKey } from "../../ws/event-buffer.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import type { ResolvedInstanceCredentials } from "../model-providers/model-provider-service.js";
import { createFlowIdentityTickets } from "./identity.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ID = "22222222-2222-4222-8222-222222222222";
const SECRET = "flow-gateway-secret";
const actor = { instanceId: INSTANCE_ID, accessClientId: null };
const localInstance: LocalInstanceService = {
  getContext: async () => ({ instanceId: INSTANCE_ID, dataDir: "/data" }),
  resolve: async () => ({ instanceId: INSTANCE_ID, dataDir: "/data" }),
  serviceActor: async () => actor,
  isDraining: () => false, assertReady() {}, beginAdmission: () => () => {}, activeAdmissionCount: () => 0, beginMaintenance: async () => {}, cancelMaintenance() {},
};
function fixture(options: { secret?: string; authorized?: boolean; configured?: boolean; baseUrl?: string; engineInfo?: { info(): Promise<unknown> }; engineStop?: (input: { deleteData: boolean }) => Promise<{ ok: boolean; error?: string }>; engineInstallStart?: (launch?: unknown) => { started: boolean; snapshot: { state: string; logTail: string[] } } } = {}) {
  const app = Fastify();
  const provider = providerInstanceResponseSchema.parse({ id: PROVIDER_ID, scope: "local", name: "Dify", protocol: "dify-engine", enabled: true, hasCredential: true, configRevision: 1, models: [], headerKeys: [] });
  const credentials: ResolvedInstanceCredentials = { instanceId: PROVIDER_ID, name: "Dify", protocol: "dify-engine", apiKey: "byok-secret", baseUrl: options.baseUrl ?? "http://127.0.0.1:8080/", configRevision: 1, models: [] };
  const listInstances = vi.fn(async () => options.configured === false ? [] : [provider]);
  const stopCalls: Array<{ deleteData: boolean }> = [];
  const installLaunches: unknown[] = [];
  const pushed: Array<{ instanceId: string; event: StreamEvent }> = [];
  const eventBuffer = new CanvasEventBuffer();
  const identityTickets = createFlowIdentityTickets();
  void registerFlowHostRoutes(app, { ...(options.engineInfo ? { engineInfo: options.engineInfo as never } : {}), localAccess: { authenticate: async () => options.authorized === false ? null : actor }, localInstance, providers: { listInstances, resolveCredentialsById: async () => credentials }, ws: { connectionManager: { pushToInstance: (instanceId, event) => { pushed.push({ instanceId, event }); } }, eventBuffer }, identity: { issue: async (forActor) => identityTickets.issue({ instanceId: forActor.instanceId, accessClientId: forActor.accessClientId, ttlMs: 60_000 }), verify: async (token) => { const entry = identityTickets.consume(token); return entry && entry.instanceId === INSTANCE_ID ? { subject: entry.instanceId, displayName: "本机" } : null; } }, engine: { probe: async () => ({ platform: "darwin", paths: [], recommended: null }) }, engineInstall: { start: (launch?: unknown) => { installLaunches.push(launch); return options.engineInstallStart ? (options.engineInstallStart(launch) as never) : { started: true, snapshot: { state: "ready", logTail: [] } }; }, status: () => ({ state: "idle", logTail: [] }) }, engineStop: { stop: async (input) => { stopCalls.push(input); return options.engineStop ? await options.engineStop(input) : { ok: true }; } }, ...(options.secret ? { secret: options.secret } : {}), frontendUrl: "http://127.0.0.1:8081" });
  return { app, pushed, listInstances, eventBuffer, stopCalls, installLaunches };
}

describe("Flow 本地实例基础设施", () => {
  it("配置齐全即开放入口；身份票据经本机接入签发、网关单次验签（重放拒绝）", async () => {
    const { app } = fixture({ secret: SECRET });
    try {
      const status = await app.inject({ method: "GET", url: "/api/flow/host/status" });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({
        enabled: true,
        frontendUrl: "http://127.0.0.1:8081",
        reasons: [],
      });

      // 伪造票据过不了验签；重放同一票据也不行（一次性消费）。
      const forged = await app.inject({ method: "POST", url: "/api/flow/host/identity", headers: { authorization: `Bearer ${SECRET}` }, payload: { token: "forged" } });
      expect(forged.statusCode).toBe(401);

      // 未授权本机接入拿不到票据。
      const deniedFixture = fixture({ secret: SECRET, authorized: false });
      try {
        const denied = await deniedFixture.app.inject({ method: "POST", url: "/api/flow/host/identity-ticket", payload: {} });
        expect(denied.statusCode).toBe(401);
      } finally { await deniedFixture.app.close(); }

      // 正式链路：换票 → 验签 → 稳定 subject；重放 401。
      const ticketResponse = await app.inject({ method: "POST", url: "/api/flow/host/identity-ticket", payload: {} });
      expect(ticketResponse.statusCode).toBe(200);
      const { token } = ticketResponse.json() as { token: string };
      const verified = await app.inject({ method: "POST", url: "/api/flow/host/identity", headers: { authorization: `Bearer ${SECRET}` }, payload: { token, protocolVersion: "v1" } });
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toEqual({ subject: INSTANCE_ID, displayName: "本机" });
      const replay = await app.inject({ method: "POST", url: "/api/flow/host/identity", headers: { authorization: `Bearer ${SECRET}` }, payload: { token } });
      expect(replay.statusCode).toBe(401);

      // 错密钥 401、版本不符 400；billing 已退役（404）。
      expect((await app.inject({ method: "POST", url: "/api/flow/host/identity", headers: { authorization: "Bearer wrong" }, payload: { token: "x" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/flow/host/identity", headers: { authorization: `Bearer ${SECRET}` }, payload: { token: "x", protocolVersion: "v9" } })).statusCode).toBe(400);
      const billing = await app.inject({ method: "POST", url: "/api/flow/host/billing", payload: {} });
      expect(billing.statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it("缺共享密钥时身份验签 503，status 如实点名缺什么", async () => {
    const { app } = fixture();
    try {
      expect((await app.inject({ method: "POST", url: "/api/flow/host/identity", payload: { token: "x" } })).statusCode).toBe(503);
      const status = await app.inject({ method: "GET", url: "/api/flow/host/status" });
      expect(status.json().enabled).toBe(false);
      expect(status.json().reasons.join(" ")).toContain("共享密钥");
    } finally { await app.close(); }
  });
  it("status及引擎探测都验证本机接入", async () => {
    const { app } = fixture({ authorized: false });
    try { for (const url of ["/api/flow/host/status", "/api/flow/host/engine", "/api/flow/host/identity-ticket"]) expect((await app.inject({ method: url.endsWith("ticket") ? "POST" : "GET", url })).statusCode).toBe(401); }
    finally { await app.close(); }
  });
  it("网关必须有明确共享密钥，错误密钥不得读本地Key", async () => {
    const missing = fixture(); const configured = fixture({ secret: SECRET });
    try {
      expect((await missing.app.inject({ method: "POST", url: "/api/flow/host/credentials", payload: {} })).statusCode).toBe(503);
      expect((await configured.app.inject({ method: "POST", url: "/api/flow/host/credentials", headers: { authorization: "Bearer forged" }, payload: {} })).statusCode).toBe(401);
      expect(configured.listInstances).not.toHaveBeenCalled();
    } finally { await missing.app.close(); await configured.app.close(); }
  });
  it("凭据来自同一本地供应商列表，只有授权网关拿到明文", async () => {
    const { app, listInstances } = fixture({ secret: SECRET });
    try {
      const response = await app.inject({ method: "POST", url: "/api/flow/host/credentials", headers: { authorization: `Bearer ${SECRET}` }, payload: {} });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ apiBase: "http://127.0.0.1:8080", apiKey: "byok-secret", label: "Dify" });
      expect(listInstances).toHaveBeenCalledWith(actor);
    } finally { await app.close(); }
  });
  it.each([{ configured: false, status: 404 }, { baseUrl: "ftp://invalid", status: 409 }])("未配置或无效引擎明确失败（$status）", async (options) => {
    const { app } = fixture({ secret: SECRET, ...options });
    try { expect((await app.inject({ method: "POST", url: "/api/flow/host/credentials", headers: { authorization: `Bearer ${SECRET}` }, payload: {} })).statusCode).toBe(options.status); }
    finally { await app.close(); }
  });
  it("事件仅投递稳定实例归属；未知subject被跳过，不能投到另一个实例", async () => {
    const { app, pushed } = fixture({ secret: SECRET });
    try {
      const event = { hostSubject: INSTANCE_ID, runId: "run-1", seq: 1, type: "completed", payload: { text: "done" }, at: "2026-10-05T00:00:00Z" };
      const response = await app.inject({ method: "POST", url: "/api/flow/host/events", headers: { authorization: `Bearer ${SECRET}` }, payload: { events: [event, { ...event, hostSubject: "other-instance" }] } });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ accepted: 1, skipped: 1 });
      expect(pushed.map((entry) => entry.instanceId)).toEqual([INSTANCE_ID]);
      expect(pushed[0]?.event).toMatchObject({ runId: "run-1", seq: 1, payload: { text: "done" } });
    } finally { await app.close(); }
  });

  it("事件同时入 EventBuffer（P5 断线续传的数据面）", async () => {
    const { app, eventBuffer } = fixture({ secret: SECRET });
    try {
      const event = { hostSubject: INSTANCE_ID, runId: "run-2", seq: 1, type: "node_finished", payload: { node: "a" }, at: "2026-10-05T00:00:01Z" };
      const response = await app.inject({ method: "POST", url: "/api/flow/host/events", headers: { authorization: `Bearer ${SECRET}` }, payload: { events: [event] } });
      expect(response.statusCode).toBe(200);
      const buffered = eventBuffer.getAfter(flowEventScopeKey(INSTANCE_ID), 0);
      expect(buffered).toHaveLength(1);
      expect(buffered[0]?.event).toMatchObject({
        type: "flowRun.event",
        runId: "run-2",
        eventType: "node_finished",
      });
      // 被跳过的归属不进缓冲
      expect(eventBuffer.getLatestSeq(flowEventScopeKey(INSTANCE_ID))).toBe(1);
    } finally { await app.close(); }
  });
});

describe("引擎信息页（/api/flow/host/engine/info）", () => {
  const engineInfo = {
    async info() {
      return {
        install: { state: "ready", logTail: ["up ok"] },
        probe: {
          platform: "win32",
          paths: [{ id: "container", label: "本机容器", available: true }],
          recommended: "container",
        },
        stack: {
          containers: [
            {
              service: "dify-api",
              name: "futureflow-dify-api-1",
              state: "running",
              health: "healthy",
              ports: ["127.0.0.1:15001->5001/tcp"],
            },
          ],
        },
        // 承载目标（落盘记录）：停止/查询都按它执行
        runtime: { kind: "host" },
        addresses: {
          composeFile: "D:/repo/dify/docker-compose.dify.yml",
          dataDir: "D:/repo/.kenfutwork-data",
        },
      };
    },
  };

  it("一次取全：状态 + 承载探测 + 容器事实 + 地址（身份回调按请求主机名拼）", async () => {
    const { app } = fixture({ secret: SECRET, engineInfo });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/flow/host/engine/info",
        headers: { host: "127.0.0.1:3301" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.install.state).toBe("ready");
      expect(body.stack.containers[0].ports).toEqual([
        "127.0.0.1:15001->5001/tcp",
      ]);
      expect(body.addresses.frontendUrl).toBe("http://127.0.0.1:8081");
      expect(body.addresses.hostIdentityUrl).toBe(
        "http://127.0.0.1:3301/api/flow/host/identity",
      );
      expect(body.addresses.composeFile).toContain("docker-compose.dify.yml");
    } finally {
      await app.close();
    }
  });

  it("快照 idle 但有运行中容器：按容器事实校正为已就绪（重启归零的口径）", async () => {
    const { app } = fixture({
      secret: SECRET,
      engineInfo: {
        async info() {
          return {
            install: { state: "idle", logTail: [] },
            probe: { platform: "win32", paths: [], recommended: null },
            stack: {
              containers: [
                {
                  service: "api",
                  name: "api-1",
                  state: "running",
                  health: "healthy",
                  ports: [],
                },
              ],
            },
            runtime: { kind: "host" },
            addresses: { composeFile: "c.yml", dataDir: "d" },
          };
        },
      },
    });
    try {
      const response = await app.inject({
        url: "/api/flow/host/engine/info",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().install.state).toBe("ready");
    } finally {
      await app.close();
    }
  });

  it("未装配数据面：503 如实说明；未授权本机接入：401", async () => {
    const missing = fixture({ secret: SECRET });
    const denied = fixture({ secret: SECRET, authorized: false, engineInfo });
    try {
      const unavailable = await missing.app.inject({
        url: "/api/flow/host/engine/info",
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json().error.code).toBe("service_unavailable");
      const unauthorized = await denied.app.inject({
        url: "/api/flow/host/engine/info",
      });
      expect(unauthorized.statusCode).toBe(401);
    } finally {
      await missing.app.close();
      await denied.app.close();
    }
  });
});

describe("引擎栈安装（/api/flow/host/engine/install）与承载目标", () => {
  it("缺省不带承载目标；带 launch 时透传（wsl2 点名发行版）", async () => {
    const { app, installLaunches } = fixture({ secret: SECRET });
    try {
      const plain = await app.inject({
        method: "POST",
        url: "/api/flow/host/engine/install",
        payload: {},
      });
      expect(plain.statusCode).toBe(200);
      expect(installLaunches[0]).toBeUndefined();

      const wsl = await app.inject({
        method: "POST",
        url: "/api/flow/host/engine/install",
        payload: { launch: { kind: "wsl2", distro: "Ubuntu" } },
      });
      expect(wsl.statusCode).toBe(200);
      expect(installLaunches[1]).toEqual({ kind: "wsl2", distro: "Ubuntu" });
    } finally {
      await app.close();
    }
  });

  it("承载目标格式不对（wsl2 缺 distro）→ 400，不进安装", async () => {
    const { app, installLaunches } = fixture({ secret: SECRET });
    try {
      const bad = await app.inject({
        method: "POST",
        url: "/api/flow/host/engine/install",
        payload: { launch: { kind: "wsl2" } },
      });
      expect(bad.statusCode).toBe(400);
      expect(installLaunches).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe("引擎栈停止（/api/flow/host/engine/stop）", () => {
  it("默认保留数据卷、deleteData 才全删；快照随停止归 idle", async () => {
    const { app, stopCalls } = fixture({ secret: SECRET });
    try {
      const stopped = await app.inject({
        method: "POST",
        url: "/api/flow/host/engine/stop",
        payload: {},
      });
      expect(stopped.statusCode).toBe(200);
      expect(stopCalls).toEqual([{ deleteData: false }]);
      expect(stopped.json().state).toBe("idle");

      const wiped = await app.inject({
        method: "POST",
        url: "/api/flow/host/engine/stop",
        payload: { deleteData: true },
      });
      expect(wiped.statusCode).toBe(200);
      expect(stopCalls[1]).toEqual({ deleteData: true });
    } finally {
      await app.close();
    }
  });

  it("未授权 401、格式不对 400、失败原样给可读原因（503）", async () => {
    const denied = fixture({ secret: SECRET, authorized: false });
    const invalid = fixture({ secret: SECRET });
    const failing = fixture({
      secret: SECRET,
      engineStop: async () => ({
        ok: false,
        error: "docker compose down 失败（退出码 1）：no such project",
      }),
    });
    try {
      expect(
        (
          await denied.app.inject({
            method: "POST",
            url: "/api/flow/host/engine/stop",
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await invalid.app.inject({
            method: "POST",
            url: "/api/flow/host/engine/stop",
            payload: { deleteData: "yes" },
          })
        ).statusCode,
      ).toBe(400);
      const failed = await failing.app.inject({
        method: "POST",
        url: "/api/flow/host/engine/stop",
        payload: {},
      });
      expect(failed.statusCode).toBe(503);
      expect(failed.json().error.message).toContain("no such project");
    } finally {
      await denied.app.close();
      await invalid.app.close();
      await failing.app.close();
    }
  });
});
