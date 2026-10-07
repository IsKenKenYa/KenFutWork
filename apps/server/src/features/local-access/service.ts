import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { LocalAccessClient } from "@kenfutwork/shared";

import type { LocalInstanceService } from "../local-instance/types.js";
import {
  ensureDesktopToken,
  generateLocalAccessToken,
  LOCAL_ACCESS_TOKEN_PATTERN,
} from "./desktop-token.js";
import {
  type LocalAccessClientRecord,
  LocalAccessError,
  type LocalAccessRequest,
  type LocalAccessRevokedListener,
  type LocalAccessService,
  type LocalAccessStore,
} from "./types.js";

export const LOCAL_ACCESS_COOKIE_NAME = "kfw_local_access";

export function hashLocalAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 来自 socket 的真实回环地址；包含 IPv4 映射 IPv6。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address || !isIP(address)) return false;
  if (isIP(address) === 4) return address.split(".")[0] === "127";
  const hostname = new URL(`http://[${address}]`).hostname;
  return (
    hostname === "[::1]" ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname)
  );
}

function toPublic(client: LocalAccessClientRecord): LocalAccessClient {
  const { instanceId: _instanceId, ...publicClient } = client;
  return publicClient;
}

function unauthorized(): LocalAccessError {
  return new LocalAccessError(
    "unauthorized",
    "本机连接凭据缺失、已失效，或请求来源不受信任。",
    401,
  );
}

type RequestCredential = { token: string | null; invalid: boolean };

/** malformed 与冲突凭据不可退回另一条认证路径。 */
function requestCredential(request: LocalAccessRequest): RequestCredential {
  const authorization = request.headers.authorization;
  const cookieHeader = request.headers.cookie;
  let cookieToken: string | undefined;
  if (typeof cookieHeader === "string") {
    for (const part of cookieHeader.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0 && part.trim() === LOCAL_ACCESS_COOKIE_NAME) {
        return { token: null, invalid: true };
      }
      if (part.slice(0, separator).trim() !== LOCAL_ACCESS_COOKIE_NAME)
        continue;
      if (cookieToken !== undefined) return { token: null, invalid: true };
      cookieToken = part.slice(separator + 1).trim();
    }
  }
  if (cookieToken !== undefined && authorization !== undefined) {
    return { token: null, invalid: true };
  }
  if (cookieToken !== undefined) {
    const valid = LOCAL_ACCESS_TOKEN_PATTERN.test(cookieToken);
    return { token: valid ? cookieToken : null, invalid: !valid };
  }
  if (authorization === undefined) return { token: null, invalid: false };
  if (typeof authorization !== "string") return { token: null, invalid: true };
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
  return { token: match?.[1] ?? null, invalid: !match };
}

type Ticket = { authorizerId: string; expiresAt: number };

export function createLocalAccessService(options: {
  store: LocalAccessStore;
  instance: Pick<LocalInstanceService, "getContext">;
  allowedOrigins: readonly string[] | (() => readonly string[]);
  readGovernance(): Promise<{ ticketTtlMs: number; sessionMaxAgeMs: number }>;
  now?: () => number;
}): LocalAccessService {
  const readOrigins = () =>
    typeof options.allowedOrigins === "function"
      ? options.allowedOrigins()
      : options.allowedOrigins;
  const validateOrigins = () => {
    const origins = new Set(readOrigins());
    for (const origin of origins) {
      const url = new URL(origin);
      if (
        url.protocol !== "http:" ||
        url.origin !== origin ||
        !(
          url.hostname === "localhost" ||
          isLoopbackAddress(url.hostname.replace(/^\[|\]$/g, ""))
        )
      ) {
        throw new Error("本机访问允许来源必须是精确的回环 HTTP Origin。");
      }
    }
    return origins;
  };
  validateOrigins();
  const now = options.now ?? Date.now;
  const tickets = new Map<string, Ticket>();
  const revokedListeners = new Set<LocalAccessRevokedListener>();
  let initialized: Promise<void> | undefined;
  let instanceId: string;
  let desktopToken: string;

  const transportAllowed = (request: LocalAccessRequest): boolean => {
    const origin = request.headers.origin;
    return (
      isLoopbackAddress(request.ip) &&
      (origin === undefined ||
        (typeof origin === "string" && validateOrigins().has(origin)))
    );
  };

  const initialize = (): Promise<void> => {
    if (!initialized) {
      initialized = (async () => {
        const context = await options.instance.getContext();
        const token = await ensureDesktopToken(context.dataDir);
        await options.store.ensureDesktop({
          id: randomUUID(),
          instanceId: context.instanceId,
          kind: "desktop",
          label: "本机桌面",
          tokenHash: hashLocalAccessToken(token),
          createdAt: new Date(now()),
          expiresAt: null,
        });
        instanceId = context.instanceId;
        desktopToken = token;
      })().catch((error: unknown) => {
        initialized = undefined;
        throw error;
      });
    }
    return initialized;
  };

  const resolveClient = async (
    request: LocalAccessRequest,
  ): Promise<LocalAccessClientRecord | null> => {
    if (!transportAllowed(request)) return null;
    const { token } = requestCredential(request);
    if (!token) return null;
    await initialize();
    return options.store.findActiveByTokenHash({
      instanceId,
      tokenHash: hashLocalAccessToken(token),
      now: new Date(now()),
    });
  };

  const requireManager = async (request: LocalAccessRequest) => {
    const client = await resolveClient(request);
    if (!client) throw unauthorized();
    if (client.kind === "api") {
      throw new LocalAccessError(
        "forbidden",
        "脚本凭据不能管理或签发接入凭据。",
        403,
      );
    }
    return client;
  };

  const purgeExpiredTickets = () => {
    const timestamp = now();
    for (const [hash, ticket] of tickets) {
      if (ticket.expiresAt <= timestamp) tickets.delete(hash);
    }
  };

  return {
    onRevoked(listener) {
      revokedListeners.add(listener);
      return () => {
        revokedListeners.delete(listener);
      };
    },
    initialize,
    async getDesktopToken() {
      await initialize();
      return desktopToken;
    },
    async authenticate(request) {
      const client = await resolveClient(request);
      return client
        ? { instanceId: client.instanceId, accessClientId: client.id }
        : null;
    },
    async issueTicket(request) {
      const client = await requireManager(request);
      const governance = await options.readGovernance();
      const token = generateLocalAccessToken();
      const expiresAt = now() + governance.ticketTtlMs;
      purgeExpiredTickets();
      tickets.set(hashLocalAccessToken(token), {
        authorizerId: client.id,
        expiresAt,
      });
      return { ticket: token, expiresAt: new Date(expiresAt).toISOString() };
    },
    async consumeTicket(request, input) {
      // 连接可以没有会话，但不能带冲突或格式错误凭据绕过公共入口纪律。
      if (!transportAllowed(request) || requestCredential(request).invalid) {
        throw unauthorized();
      }
      purgeExpiredTickets();
      const hash = hashLocalAccessToken(input.ticket);
      const ticket = tickets.get(hash);
      tickets.delete(hash); // 必须在第一次 await 前删除：并发消费 first-wins。
      if (!ticket) {
        throw new LocalAccessError(
          "local_access_invalid_ticket",
          "连接票据已过期或已使用，请重新从桌面打开。",
          401,
        );
      }
      const governance = await options.readGovernance();
      const token = generateLocalAccessToken();
      const createdAt = new Date(now());
      const expiresAt = new Date(
        createdAt.getTime() + governance.sessionMaxAgeMs,
      );
      const client = await options.store.createAuthorized({
        authorizerId: ticket.authorizerId,
        now: createdAt,
        client: {
          id: randomUUID(),
          instanceId,
          kind: "browser",
          label: input.label ?? "本机浏览器",
          tokenHash: hashLocalAccessToken(token),
          createdAt,
          expiresAt,
        },
      });
      if (!client) throw unauthorized();
      return {
        actor: { instanceId: client.instanceId, accessClientId: client.id },
        client: toPublic(client),
        cookie: `${LOCAL_ACCESS_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(governance.sessionMaxAgeMs / 1000)}; Expires=${expiresAt.toUTCString()}`,
      };
    },
    async createApiClient(request, input) {
      const authorizer = await requireManager(request);
      const token = generateLocalAccessToken();
      const createdAt = new Date(now());
      const client = await options.store.createAuthorized({
        authorizerId: authorizer.id,
        now: createdAt,
        client: {
          id: randomUUID(),
          instanceId,
          kind: "api",
          label: input.label,
          tokenHash: hashLocalAccessToken(token),
          createdAt,
          expiresAt: null,
        },
      });
      if (!client) throw unauthorized();
      return { client: toPublic(client), token };
    },
    async listClients(request) {
      const authorizer = await requireManager(request);
      const clients = await options.store.listAuthorized({
        instanceId,
        authorizerId: authorizer.id,
        now: new Date(now()),
      });
      if (!clients) throw unauthorized();
      return clients.map(toPublic);
    },
    async revokeClient(request, clientId) {
      const authorizer = await requireManager(request);
      const result = await options.store.revokeAuthorized({
        instanceId,
        authorizerId: authorizer.id,
        clientId,
        now: new Date(now()),
      });
      if (result === "unauthorized") throw unauthorized();
      if (result === "desktop") {
        throw new LocalAccessError(
          "forbidden",
          "桌面启动凭据由本机数据目录管理，不能在此撤销。",
          403,
        );
      }
      if (result === "revoked") {
        const notified = await Promise.allSettled(
          [...revokedListeners].map(async (listener) => {
            await listener(clientId);
          }),
        );
        const failures = notified.filter(
          (result) => result.status === "rejected",
        );
        if (failures.length) {
          console.warn("本机凭据已撤销，部分连接关闭尚未确认。");
          throw new LocalAccessError(
            "local_access_unavailable",
            "接入凭据已撤销，部分连接关闭尚未确认，请重试撤销。",
            503,
          );
        }
      }
    },
  };
}
