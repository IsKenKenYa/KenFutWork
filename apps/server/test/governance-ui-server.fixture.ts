import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import {
  instanceSettingsResponseSchema,
  localAccessTicketResponseSchema,
} from "@kenfutwork/shared";
import { selectAgentGovernanceSettings } from "../../web/src/lib/agent-governance-settings.js";
import type {
  Command,
  GateSummary,
  Inspection,
  Reply,
  RequestSummary,
} from "../../web/test/setup/governance-ui-server-types.js";
import { buildApp } from "../src/app.js";
import { createSettingsRepository } from "../src/features/settings/repository.js";
import { createTaskWorkDatabase } from "../src/features/task-work/test-postgres-schema.js";

const ORIGIN = "http://localhost:3300";
const SETTINGS_PATH = "/api/instance/settings";
let signalRequested = false;
let signalClose: (() => Promise<void>) | undefined;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    signalRequested = true;
    if (signalClose)
      void signalClose().finally(() => {
        if (process.connected) process.disconnect();
        process.exitCode = 1;
      });
  });

function send(message: Reply) {
  if (process.connected) process.send?.(message);
}

function clearApplicationEnv() {
  for (const key of Object.keys(process.env))
    if (
      /^(KENFUTWORK_|LOOMIC_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|REPLICATE_|METASO_|VOLCES_|LEMON_|PG)/u.test(
        key,
      ) ||
      ["DATABASE_URL", "SUPABASE_DB_URL", "PORT", "HOST"].includes(key)
    )
      delete process.env[key];
}

async function browserCookie(
  app: ReturnType<typeof buildApp>,
  apiBase: string,
) {
  const desktopToken = await app.kernel.get("localAccess").getDesktopToken();
  const ticketResponse = await fetch(`${apiBase}/api/local-access/tickets`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${desktopToken}`,
      origin: ORIGIN,
      "content-type": "application/json",
      connection: "close",
    },
    body: "{}",
  });
  if (ticketResponse.status !== 201) throw new Error("ticket_failed");
  const ticket = localAccessTicketResponseSchema.parse(
    await ticketResponse.json(),
  );
  const connected = await fetch(`${apiBase}/api/local-access/connect`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify({
      ticket: ticket.ticket,
      label: "治理UI真实浏览器夹具",
    }),
  });
  const header = connected.headers.get("set-cookie");
  if (connected.status !== 200 || !header || !/;\s*HttpOnly/iu.test(header))
    throw new Error("browser_cookie_failed");
  const cookie = header.split(";")[0];
  if (!cookie) throw new Error("browser_cookie_empty");
  const actor = await app.kernel.get("localAccess").authenticate({
    ip: "127.0.0.1",
    headers: { origin: ORIGIN, cookie },
  });
  if (!actor) throw new Error("browser_actor_failed");
  return { cookie, actor };
}

type Gate = GateSummary & {
  hold: boolean;
  release?: () => void;
  disconnect?: () => void;
  match?: { key: string; value: number | boolean };
};

async function readBody(request: IncomingMessage) {
  const parts: Buffer[] = [];
  for await (const chunk of request) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

function publicPatch(bytes: Buffer): Record<string, number | boolean> {
  const body = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(body).filter(
      (entry): entry is [string, number | boolean] =>
        typeof entry[1] === "number" || typeof entry[1] === "boolean",
    ),
  );
}

function createRelay(apiBase: string, cookie: string) {
  const gates = new Map<string, Gate>();
  const requests: RequestSummary[] = [];
  const relay = createServer((request, response) => {
    void forward(request, response).catch(() => response.destroy());
  });
  async function forward(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.origin && request.headers.origin !== ORIGIN) {
      response.destroy();
      return;
    }
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const method = request.method ?? "GET";
    if (!path.startsWith("/api/")) {
      response.destroy();
      return;
    }
    const bytes = await readBody(request);
    const record: RequestSummary = { id: randomUUID(), path, method };
    if (method === "PATCH" && path === SETTINGS_PATH) {
      record.patch = publicPatch(bytes);
      record.patchKeys = Object.keys(JSON.parse(bytes.toString("utf8")));
    }
    requests.push(record);
    const gate = [...gates.values()].find(
      (entry) =>
        entry.state === "armed" &&
        path === SETTINGS_PATH &&
        entry.method === method &&
        (!entry.match || record.patch?.[entry.match.key] === entry.match.value),
    );
    // 一次性占用；之后新周期请求不会被旧gate截住。
    if (gate) {
      gate.state = "captured";
      gate.requestId = record.id;
      gate.disconnect = () => {
        gate.state = "dropped";
        response.destroy();
        gate.release?.();
        delete gate.release;
      };
    }
    if (gate?.hold && gate.phase === "request")
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    if (response.destroyed) return;
    if (gate) gate.requestSent = true;
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    const upstream = await fetch(`${apiBase}${request.url ?? path}`, {
      method,
      headers: {
        origin: ORIGIN,
        cookie,
        ...(request.headers["content-type"]
          ? { "content-type": request.headers["content-type"] }
          : {}),
        ...(request.headers["access-control-request-method"]
          ? {
              "access-control-request-method": String(
                request.headers["access-control-request-method"],
              ),
            }
          : {}),
        ...(request.headers["access-control-request-headers"]
          ? {
              "access-control-request-headers": String(
                request.headers["access-control-request-headers"],
              ),
            }
          : {}),
        connection: "close",
      },
      signal: abort.signal,
      ...(bytes.length && !["GET", "HEAD"].includes(method)
        ? { body: new Uint8Array(bytes) }
        : {}),
    });
    record.status = upstream.status;
    const headers = Object.fromEntries(
      [...upstream.headers].filter(
        ([key]) =>
          ![
            "connection",
            "transfer-encoding",
            "content-length",
            "content-encoding",
          ].includes(key),
      ),
    );
    if (
      !gate &&
      upstream.headers.get("content-type")?.includes("text/event-stream")
    ) {
      response.writeHead(upstream.status, headers);
      const reader = upstream.body?.getReader();
      if (reader) {
        try {
          while (!response.destroyed) {
            const chunk = await reader.read();
            if (chunk.done) break;
            response.write(Buffer.from(chunk.value));
          }
        } finally {
          reader.releaseLock();
        }
      }
      response.end();
      return;
    }
    const payload = Buffer.from(await upstream.arrayBuffer());
    if (gate) gate.status = upstream.status;
    if (gate?.hold && gate.phase === "response")
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    if (response.destroyed) return;
    response.on("finish", () => {
      if (gate) gate.state = "delivered";
    });
    response.writeHead(upstream.status, headers).end(payload);
  }
  return {
    relay,
    requests,
    summaries: () =>
      [...gates.values()].map(
        ({ id, requestId, method, state, status, phase, requestSent }) => ({
          id,
          method,
          state,
          phase,
          requestSent,
          ...(requestId === undefined ? {} : { requestId }),
          ...(status === undefined ? {} : { status }),
        }),
      ),
    arm(command: Extract<Command, { operation: "gate" }>) {
      if (gates.has(command.id)) throw new Error("gate_exists");
      gates.set(command.id, {
        id: command.id,
        method: command.method,
        state: "armed",
        hold: command.hold ?? true,
        phase: command.phase ?? "response",
        requestSent: false,
        ...(command.match ? { match: command.match } : {}),
      });
    },
    release(id: string) {
      const gate = gates.get(id);
      if (!gate?.release) throw new Error("gate_not_ready");
      gate.release();
      delete gate.release;
    },
    drop(id: string) {
      const gate = gates.get(id);
      if (!gate?.disconnect || gate.state !== "captured")
        throw new Error("gate_not_captured");
      gate.disconnect();
      delete gate.disconnect;
    },
    async close() {
      for (const gate of gates.values()) gate.release?.();
      relay.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        relay.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function start() {
  clearApplicationEnv();
  const database = await createTaskWorkDatabase();
  let app: ReturnType<typeof buildApp> | undefined;
  let transport: ReturnType<typeof createRelay> | undefined;
  let stopped = false;
  async function close() {
    if (stopped) return;
    stopped = true;
    try {
      await transport?.close();
    } finally {
      try {
        await app?.close();
      } finally {
        await database.close();
      }
    }
  }
  signalClose = close;
  if (signalRequested) {
    await close();
    if (process.connected) process.disconnect();
    process.exitCode = 1;
    return;
  }
  try {
    const pluginsDir = join(database.directory, "plugins");
    await mkdir(pluginsDir);
    process.env.KENFUTWORK_PLUGINS_DIR = pluginsDir;
    app = buildApp({
      env: {
        databaseUrl: database.connectionString,
        desktopDataDir: database.directory,
        queueDriver: "in-process",
        agentFilesRoot: join(database.directory, "agent-files"),
        blobDir: join(database.directory, "blobs"),
        sandboxRoot: join(database.directory, "sandbox"),
        checkpointRoot: join(database.directory, "checkpoints"),
        webOrigin: ORIGIN,
        serverHost: "127.0.0.1",
      },
    });
    const apiBase = await app.listen({ host: "127.0.0.1", port: 0 });
    const { cookie, actor } = await browserCookie(app, apiBase);
    if (signalRequested) throw new Error("fixture_stop_requested");
    const repository = createSettingsRepository(database.persistence);
    transport = createRelay(apiBase, cookie);
    const relay = transport;
    await new Promise<void>((resolve) =>
      relay.relay.listen(0, "127.0.0.1", resolve),
    );
    const address = relay.relay.address();
    if (!address || typeof address === "string")
      throw new Error("relay_address_failed");
    async function inspect(): Promise<Inspection> {
      const response = await fetch(`${apiBase}${SETTINGS_PATH}`, {
        headers: { origin: ORIGIN, cookie, connection: "close" },
      });
      if (response.status !== 200) throw new Error("inspect_http_failed");
      const settings = instanceSettingsResponseSchema.parse(
        await response.json(),
      ).settings;
      const values = selectAgentGovernanceSettings(settings);
      const id = actor.instanceId;
      const [
        depth,
        concurrency,
        retries,
        infinite,
        timeout,
        continuations,
        runtime,
      ] = await Promise.all([
        repository.findSubagentMaxDepth(id),
        repository.findSubagentMaxConcurrency(id),
        repository.findLlmRequestMaxRetries(id),
        repository.findLlmInfiniteRetry(id),
        repository.findExecuteTimeoutMs(id),
        repository.findSubagentMaxContinuations(id),
        repository.findRuntimeGovernance(id),
      ]);
      const governance = runtime as Record<string, number>;
      return {
        instanceId: id,
        values,
        indexValues: {
          enabled: settings.codeIndexEnabled,
          autoNewFolder: settings.codeIndexAutoNewFolder,
        },
        collections: { commands: settings.commands, hooks: settings.hooks },
        stored: {
          subagentMaxDepth: depth,
          subagentMaxConcurrency: concurrency,
          llmRequestMaxRetries: retries,
          llmInfiniteRetry: infinite,
          executeTimeoutMs: timeout,
          agentStreamIdleTimeoutMs: governance.agentStreamIdleTimeoutMs ?? null,
          subagentMaxContinuations: continuations,
          compactKeepMessages: governance.compactKeepMessages ?? null,
          compactFallbackKeepMessages:
            governance.compactFallbackKeepMessages ?? null,
        },
        gates: relay.summaries(),
        requests: relay.requests,
      };
    }
    process.on("message", (raw) => {
      const command = raw as Command;
      void (async () => {
        try {
          if (command.operation === "gate") relay.arm(command);
          if (command.operation === "release") relay.release(command.id);
          if (command.operation === "drop") relay.drop(command.id);
          if (command.operation === "inspect") {
            send({
              type: "reply",
              requestId: command.requestId,
              ok: true,
              value: await inspect(),
            });
            return;
          }
          if (command.operation === "stop") await close();
          send({ type: "reply", requestId: command.requestId, ok: true });
          if (command.operation === "stop") {
            process.disconnect();
            process.exitCode = 0;
          }
        } catch {
          send({
            type: "reply",
            requestId: command.requestId,
            ok: false,
            error: "fixture_control_failed",
          });
        }
      })();
    });
    process.on("disconnect", () => {
      void close();
    });
    send({
      type: "ready",
      baseUrl: `http://127.0.0.1:${address.port}`,
      instanceId: actor.instanceId,
      dataDir: database.directory,
    });
  } catch {
    await close();
    send({ type: "failed", error: "real_ui_fixture_start_failed" });
    process.exitCode = 1;
  }
}

void start().catch(() => {
  send({ type: "failed", error: "real_ui_fixture_start_failed" });
  if (process.connected) process.disconnect();
  process.exitCode = 1;
});
