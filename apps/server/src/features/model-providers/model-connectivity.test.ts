import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { createModelProviderService } from "./model-provider-service.js";
import {
  createModelProviderRepository,
  type ProviderInstanceRecord,
} from "./repository.js";
import { encryptSecret } from "./secret-store.js";

const key = "private-provider-key";
const header = "private-provider-header";
const credentialSecret = "connectivity-test-secret";
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const actor = {
  id: "actor",
  email: "actor@test",
  accessToken: "test",
  userMetadata: {},
};
const governance = { timeoutMs: 3000, maxAttempts: 1, infinite: false };

async function fixture(
  options: {
    fail?: boolean;
    model?: Partial<NonNullable<ProviderInstanceRecord["models"]>[number]>;
    credential?: boolean;
    disabled?: boolean;
    hang?: boolean;
  } = {},
) {
  const requests: Array<{
    path: string;
    body: Record<string, unknown>;
    headers: Record<string, unknown>;
  }> = [];
  const server = createServer(async (request, response) => {
    let data = "";
    for await (const chunk of request) data += chunk;
    requests.push({
      path: request.url ?? "",
      body: JSON.parse(data),
      headers: request.headers,
    });
    if (options.hang) return;
    response.writeHead(options.fail ? 400 : 200, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify(
        options.fail
          ? { error: { message: `Denied ${key} ${header}` } }
          : {
              id: "reply",
              object: "chat.completion",
              created: 1,
              model: "selected-model",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "OK" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            },
      ),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("连接夹具未获得端口。");
  const row: ProviderInstanceRecord = {
    id: "provider",
    scope: "workspace",
    workspace_id: "workspace",
    name: "实际供应商",
    protocol: "openai-compatible",
    base_url: `http://127.0.0.1:${address.port}/v1`,
    encrypted_api_key:
      options.credential === false
        ? null
        : encryptSecret({ credentialSecret }, key),
    models: [
      {
        id: "selected-model",
        name: "实际模型",
        capability: "chat",
        extraBody: { reasoning_effort: "low" },
        ...options.model,
      },
    ],
    compat: { chatApi: "completions" },
    headers: { "x-custom": header, "x-session": "{{sessionId}}" },
    enabled: !options.disabled,
    config_revision: "1",
    probe_result: {
      responsesApi: true,
      streamUsage: true,
      strictToolSchema: true,
    },
    probed_at: null,
  };
  const runner: PostgresQueryRunner = {
    query: async () => ({ rowCount: 1, rows: [row] }),
    acquire: async () => ({
      query: async () => ({ rowCount: 1, rows: [row] }),
      release() {},
    }),
    acquireSession: async () => {
      throw new Error("连接测试不建立Task宿主会话。");
    },
    end: async () => {},
  };
  const service = createModelProviderService({
    credentialEnv: { credentialSecret },
    repository: createModelProviderRepository(
      createPersistenceFromRunner(runner),
    ),
    viewerService: {
      resolveWorkspace: async () => ({
        id: "workspace",
        name: "workspace",
        ownerUserId: actor.id,
        type: "personal",
      }),
      ensureViewer: async () => {
        throw new Error("unused");
      },
      updateProfile: async () => {
        throw new Error("unused");
      },
    },
  });
  return { service, requests };
}

it("连接验证实际所选模型、原生方言、当前头和模型extraBody", async () => {
  const { service, requests } = await fixture();
  expect(
    await service.testModelConnectivity(
      actor,
      { instanceId: "provider", modelId: "selected-model" },
      governance,
    ),
  ).toEqual({ modelId: "selected-model", success: true });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.path).toBe("/v1/chat/completions");
  expect(requests[0]?.body).toMatchObject({
    model: "selected-model",
    reasoning_effort: "low",
    stream: false,
  });
  expect(requests[0]?.headers).toMatchObject({
    authorization: `Bearer ${key}`,
    "x-custom": header,
  });
  expect(requests[0]?.headers["x-session"]).toMatch(/^[a-f0-9-]+$/);
});

it("能力probe为true也不能代替实际调用失败，错误不得泄漏凭证或自定义头", async () => {
  const { service, requests } = await fixture({ fail: true });
  const result = await service.testModelConnectivity(
    actor,
    { instanceId: "provider", modelId: "selected-model" },
    governance,
  );
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain("Denied");
  expect(JSON.stringify(result)).not.toContain(key);
  expect(JSON.stringify(result)).not.toContain(header);
  expect(requests).toHaveLength(1);
});

it("停用、缺Key、未声明或停用模型均可读失败且不发请求", async () => {
  for (const options of [
    { credential: false },
    { disabled: true },
    { model: { enabled: false } },
    { model: { id: "other-model" } },
  ]) {
    const { service, requests } = await fixture(options);
    const result = await service.testModelConnectivity(
      actor,
      { instanceId: "provider", modelId: "selected-model" },
      governance,
    );
    expect(result.success).toBe(false);
    expect(result.error?.message.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(0);
  }
});

it("存储与调用额外参数都不能覆盖所选模型或凭证", async () => {
  for (const extraBody of [
    { model: "evil" },
    { apiKey: "evil" },
    { headers: { authorization: "evil" } },
    { messages: [] },
    { input: "evil" },
  ]) {
    const stored = await fixture({ model: { extraBody } });
    expect(
      (
        await stored.service.testModelConnectivity(
          actor,
          { instanceId: "provider", modelId: "selected-model" },
          governance,
        )
      ).success,
    ).toBe(false);
    expect(stored.requests).toHaveLength(0);
    const incoming = await fixture();
    expect(
      (
        await incoming.service.testModelConnectivity(
          actor,
          { instanceId: "provider", modelId: "selected-model", extraBody },
          governance,
        )
      ).success,
    ).toBe(false);
    expect(incoming.requests).toHaveLength(0);
  }
});

it("连接整体deadline结束挂起原生请求", async () => {
  const { service, requests } = await fixture({ hang: true });
  const result = await service.testModelConnectivity(
    actor,
    { instanceId: "provider", modelId: "selected-model" },
    { ...governance, timeoutMs: 100 },
  );
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/超时|abort|timeout/i);
  expect(requests).toHaveLength(1);
});

it("治理0仍首尝试一次；无限重试遇鉴权/参数拒绝不重复请求", async () => {
  for (const options of [
    { ...governance, maxAttempts: 0 },
    { ...governance, infinite: true },
  ]) {
    const { service, requests } = await fixture({ fail: true });
    expect(
      (
        await service.testModelConnectivity(
          actor,
          { instanceId: "provider", modelId: "selected-model" },
          options,
        )
      ).success,
    ).toBe(false);
    expect(requests).toHaveLength(1);
  }
});

it("取消终止无deadline的无限连接验证", async () => {
  const { service, requests } = await fixture({ hang: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("测试取消")), 100);
  try {
    const result = await service.testModelConnectivity(
      actor,
      { instanceId: "provider", modelId: "selected-model" },
      {
        ...governance,
        timeoutMs: null,
        infinite: true,
        signal: controller.signal,
      },
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("测试取消");
    expect(requests).toHaveLength(1);
  } finally {
    clearTimeout(timer);
  }
});
