import { providerInstanceResponseSchema, type StreamEvent } from "@kenfutwork/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerFlowHostRoutes } from "../../http/flow-host.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import type { ResolvedInstanceCredentials } from "../model-providers/model-provider-service.js";

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
function fixture(options: { secret?: string; authorized?: boolean; configured?: boolean; baseUrl?: string; engineInfo?: { info(): Promise<unknown> } } = {}) {
  const app = Fastify();
  const provider = providerInstanceResponseSchema.parse({ id: PROVIDER_ID, scope: "local", name: "Dify", protocol: "dify-engine", enabled: true, hasCredential: true, configRevision: 1, models: [], headerKeys: [] });
  const credentials: ResolvedInstanceCredentials = { instanceId: PROVIDER_ID, name: "Dify", protocol: "dify-engine", apiKey: "byok-secret", baseUrl: options.baseUrl ?? "http://127.0.0.1:8080/", configRevision: 1, models: [] };
  const listInstances = vi.fn(async () => options.configured === false ? [] : [provider]);
  const pushed: Array<{ instanceId: string; event: StreamEvent }> = [];
  void registerFlowHostRoutes(app, { ...(options.engineInfo ? { engineInfo: options.engineInfo as never } : {}), localAccess: { authenticate: async () => options.authorized === false ? null : actor }, localInstance, providers: { listInstances, resolveCredentialsById: async () => credentials }, ws: { connectionManager: { pushToInstance: (instanceId, event) => { pushed.push({ instanceId, event }); } } }, engine: { probe: async () => ({ platform: "darwin", paths: [], recommended: null }) }, engineInstall: { start: () => ({ started: true, snapshot: { state: "ready", logTail: [] } }), status: () => ({ state: "ready", logTail: [] }) }, ...(options.secret ? { secret: options.secret } : {}), frontendUrl: "http://127.0.0.1:8081" });
  return { app, pushed, listInstances };
}

describe("Flow 本地实例基础设施", () => {
  it("配置齐全仍明确关闭入口，不暴露未接通身份适配", async () => {
    const { app } = fixture({ secret: SECRET });
    try {
      const response = await app.inject({ method: "GET", url: "/api/flow/host/status" });
      expect(response.statusCode).toBe(200);
      expect(response.json().enabled).toBe(false);
      expect(response.json().reasons.join(" ")).toContain("身份适配尚未接通");
      const identity = await app.inject({ method: "POST", url: "/api/flow/host/identity", payload: { token: "forged" } });
      expect(identity.statusCode).toBe(503);
      expect(identity.json().error.code).toBe("service_unavailable");
      const billing = await app.inject({ method: "POST", url: "/api/flow/host/billing", payload: {} });
      expect(billing.statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it("status及引擎探测都验证本机接入", async () => {
    const { app } = fixture({ authorized: false });
    try { for (const url of ["/api/flow/host/status", "/api/flow/host/engine"]) expect((await app.inject({ url })).statusCode).toBe(401); }
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
        addresses: {
          composeFile: "D:/repo/docker-compose.dify.yml",
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
