import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentGovernanceOverrides,
  localAccessTicketResponseSchema,
} from "@kenfutwork/shared";
import { afterEach, beforeEach } from "vitest";
import { buildApp } from "../../app.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCodeUiTestClient } from "./host-client.fixture.js";

export function applicationEnvKey(key: string) {
  return (
    /^(KENFUTWORK_|LOOMIC_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|REPLICATE_|METASO_|VOLCES_|LEMON_)/u.test(
      key,
    ) || ["DATABASE_URL", "SUPABASE_DB_URL", "PORT", "HOST"].includes(key)
  );
}

/** 独占真实HTTP/SSE/PG；只用共享迁移创建schema，不读取.env或任何现存DSN。 */
export async function createCodeUiHttpFixture(
  options: {
    builtinPluginsDir?: string;
    allowThirdPartyPlugins?: boolean;
    governanceEnv?: AgentGovernanceOverrides;
    gitBinDir?: string;
    databaseTransport?: (connectionString: string) => Promise<{
      connectionString: string;
      close(): Promise<void>;
    }>;
  } = {},
) {
  const database = await createTaskWorkDatabase();
  const directory = database.directory;
  const origin = "http://localhost:3300";
  const pluginsDir = join(directory, "plugins");
  await mkdir(pluginsDir);
  const saved = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (applicationEnvKey(key) && value !== undefined) {
      saved.set(key, value);
      delete process.env[key];
    }
  }
  process.env.KENFUTWORK_PLUGINS_DIR = pluginsDir;
  if (options.builtinPluginsDir)
    process.env.KENFUTWORK_BUILTIN_PLUGINS_DIR = options.builtinPluginsDir;
  if (options.allowThirdPartyPlugins !== undefined)
    process.env.KENFUTWORK_ALLOW_THIRD_PARTY_PLUGINS = String(
      options.allowThirdPartyPlugins,
    );
  let app: ReturnType<typeof buildApp> | undefined;
  let databaseTransport:
    | Awaited<ReturnType<NonNullable<typeof options.databaseTransport>>>
    | undefined;
  try {
    databaseTransport = await options.databaseTransport?.(
      database.connectionString,
    );
    app = buildApp({
      env: {
        databaseUrl:
          databaseTransport?.connectionString ?? database.connectionString,
        desktopDataDir: directory,
        queueDriver: "in-process",
        agentFilesRoot: join(directory, "agent-files"),
        blobDir: join(directory, "blobs"),
        sandboxRoot: join(directory, "sandbox"),
        checkpointRoot: join(directory, "checkpoints"),
        ...(options.gitBinDir ? { gitBinDir: options.gitBinDir } : {}),
        webOrigin: origin,
        ...(options.governanceEnv
          ? { agentGovernance: options.governanceEnv }
          : {}),
        serverHost: "127.0.0.1",
      },
    });
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const host = app;
    // 桌面真实凭据授权一次性入口，浏览器再兑换自己的 HttpOnly 会话。
    const desktopToken = await host.kernel.get("localAccess").getDesktopToken();
    const ticketResponse = await fetch(`${baseUrl}/api/local-access/tickets`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${desktopToken}`,
        origin,
        "content-type": "application/json",
        connection: "close",
      },
      body: "{}",
    });
    if (ticketResponse.status !== 201)
      throw new Error("独占HTTP夹具无法签发本机连接入口。");
    const ticket = localAccessTicketResponseSchema.parse(
      await ticketResponse.json(),
    );
    const connected = await fetch(`${baseUrl}/api/local-access/connect`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        ticket: ticket.ticket,
        label: "Code UI 集成浏览器",
      }),
    });
    if (connected.status !== 200)
      throw new Error("独占HTTP夹具无法兑换本机会话。");
    const cookieHeader = connected.headers.get("set-cookie");
    if (!cookieHeader || !/;\s*HttpOnly/i.test(cookieHeader))
      throw new Error("独占HTTP夹具未得到 HttpOnly 接入 cookie。");
    const cookie = cookieHeader.split(";")[0];
    if (!cookie) throw new Error("独占HTTP夹具会话 cookie 为空。");
    const actor = await host.kernel
      .get("localAccess")
      .authenticate({ ip: "127.0.0.1", headers: { origin, cookie } });
    if (!actor) throw new Error("独占HTTP夹具会话无法通过真实接入授权。");
    const client = createCodeUiTestClient({
      baseUrl,
      origin,
      headers: { cookie },
    });
    let closing: Promise<void> | undefined;
    return {
      app: host,
      database,
      directory,
      pluginsDir,
      baseUrl,
      origin,
      client,
      actor,
      close() {
        closing ??= (async () => {
          const failures: unknown[] = [];
          // 各资源按原顺序收尾；宿主失败仍须关闭本fixture的传输/PG，并保留失败。
          for (const close of [
            () => client.close(),
            () => host.close(),
            () => databaseTransport?.close(),
            () => database.close(),
          ]) {
            try {
              await close();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length)
            throw new AggregateError(
              failures,
              "独占Code测试资源未全部确认关闭。",
            );
        })().catch((error: unknown) => {
          closing = undefined;
          throw error;
        });
        return closing;
      },
    };
  } catch (error) {
    await app?.close();
    await databaseTransport?.close();
    await database.close();
    throw error;
  } finally {
    for (const key of Object.keys(process.env))
      if (applicationEnvKey(key)) delete process.env[key];
    for (const [key, value] of saved) process.env[key] = value;
  }
}

/** 既有外部HTTP场景逐例取得独占DB及真实浏览器连接，不读取共享DSN。 */
export function useCodeUiHttpFixture(
  options: Parameters<typeof createCodeUiHttpFixture>[0] = {},
) {
  const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
  let active: Awaited<ReturnType<typeof createCodeUiHttpFixture>> | undefined;
  let connectionId: string | undefined;
  beforeEach(async () => {
    if (!enabled) return;
    active = await createCodeUiHttpFixture(options);
    const stream = await active.client.openCodeStream();
    connectionId = stream.ready.hello.connectionId;
    const initialized = await stream.rpc("initializeConversationV4", [
      {
        kind: "clientHello",
        protocolVersion: 3,
        clientId: randomUUID(),
        appVersion: "isolated-http-test",
        clientKind: "web",
      },
    ]);
    if (initialized.status !== 200)
      throw new Error("独占HTTP夹具无法初始化原Code连接。");
  });
  afterEach(async () => {
    const current = active;
    active = undefined;
    connectionId = undefined;
    await current?.close();
  });
  function current() {
    if (!active) throw new Error("独占HTTP夹具尚未初始化。");
    return active;
  }
  return {
    readResource: (path: string) => current().client.readResource(path),
    request: (
      ...args: Parameters<ReturnType<typeof createCodeUiTestClient>["request"]>
    ) => {
      const [path, body, method] = args;
      return current().client.request(
        path,
        path === "/api/code-ui/rpc" && body !== null && typeof body === "object"
          ? { connectionId, ...body }
          : body,
        method,
      );
    },
    openCodeStream: (
      ...args: Parameters<
        ReturnType<typeof createCodeUiTestClient>["openCodeStream"]
      >
    ) => current().client.openCodeStream(...args),
    databaseUrl: () => current().database.connectionString,
    pluginsDirectory: () => current().pluginsDir,
  };
}

const appSessions = new WeakMap<
  ReturnType<typeof buildApp>,
  Promise<{ cookie: string; connectionId: string }>
>();
/** 重启/宿主关闭测试仍通过真实HTTP票据和SSE建连接，再向真实路由inject请求。 */
export async function codeUiAuthorizedInject(
  app: ReturnType<typeof buildApp>,
  options: import("fastify").InjectOptions,
): Promise<import("fastify").LightMyRequestResponse> {
  let pending = appSessions.get(app);
  if (!pending) {
    pending = (async () => {
      const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
      const origin = "http://localhost:3300";
      const desktopToken = await app.kernel
        .get("localAccess")
        .getDesktopToken();
      const issued = await app.inject({
        method: "POST",
        url: "/api/local-access/tickets",
        headers: { origin, authorization: `Bearer ${desktopToken}` },
        payload: {},
      });
      if (issued.statusCode !== 201)
        throw new Error("重启夹具无法签发连接入口。");
      const ticket = localAccessTicketResponseSchema.parse(issued.json());
      const connected = await app.inject({
        method: "POST",
        url: "/api/local-access/connect",
        headers: { origin },
        payload: { ticket: ticket.ticket, label: "Code 重启测试" },
      });
      const setCookie = connected.headers["set-cookie"];
      const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      if (
        connected.statusCode !== 200 ||
        typeof value !== "string" ||
        !/;\s*HttpOnly/i.test(value)
      )
        throw new Error("重启夹具无法兑换本机会话。");
      const cookie = value.split(";")[0];
      if (!cookie) throw new Error("重启夹具会话为空。");
      const client = createCodeUiTestClient({
        baseUrl,
        origin,
        headers: { cookie },
      });
      const stream = await client.openCodeStream();
      const initialized = await stream.rpc("initializeConversationV4", [
        {
          kind: "clientHello",
          protocolVersion: 3,
          clientId: randomUUID(),
          appVersion: "restart-http-test",
          clientKind: "web",
        },
      ]);
      if (initialized.status !== 200)
        throw new Error("重启夹具无法初始化Code连接。");
      return { cookie, connectionId: stream.ready.hello.connectionId };
    })();
    appSessions.set(app, pending);
  }
  const session = await pending;
  const { payload, ...injectOptions } = options;
  const boundPayload =
    options.url === "/api/code-ui/rpc" &&
    payload !== null &&
    typeof payload === "object"
      ? { connectionId: session.connectionId, ...payload }
      : payload;
  const injected: import("fastify").InjectOptions = {
    ...injectOptions,
    headers: {
      origin: "http://localhost:3300",
      cookie: session.cookie,
      ...options.headers,
    },
    ...(boundPayload === undefined ? {} : { payload: boundPayload }),
  };
  return app.inject(injected);
}
