import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalInstanceService } from "../local-instance/service.js";
import { createLocalAccessService } from "./service.js";
import type {
  LocalAccessClientInput,
  LocalAccessClientRecord,
  LocalAccessRequest,
  LocalAccessStore,
} from "./types.js";

type StoredClient = LocalAccessClientRecord & { tokenHash: string };

function record(input: LocalAccessClientInput): StoredClient {
  return {
    id: input.id,
    instanceId: input.instanceId,
    kind: input.kind,
    label: input.label,
    tokenHash: input.tokenHash,
    createdAt: input.createdAt.toISOString(),
    expiresAt: input.expiresAt?.toISOString() ?? null,
    revokedAt: null,
  };
}

function withoutHash(client: StoredClient): LocalAccessClientRecord {
  const { tokenHash: _hash, ...result } = client;
  return result;
}

export async function createLocalAccessFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "kfw-local-access-"));
  const instanceId = randomUUID();
  const instance = createLocalInstanceService({
    repository: { ensure: async () => instanceId },
    dataDir,
  });
  const clients = new Map<string, StoredClient>();
  let timestamp = Date.parse("2026-10-05T00:00:00Z");
  let beforeCreate: (() => Promise<void>) | undefined;
  const active = (client: StoredClient | undefined, date: Date) =>
    client &&
    client.instanceId === instanceId &&
    client.revokedAt === null &&
    (client.expiresAt === null ||
      Date.parse(client.expiresAt) > date.getTime());
  const manager = (id: string, date: Date) => {
    const client = clients.get(id);
    return active(client, date) && client?.kind !== "api";
  };
  const store: LocalAccessStore = {
    async ensureDesktop(input) {
      const found = [...clients.values()].find(
        (client) => client.tokenHash === input.tokenHash,
      );
      if (found) return withoutHash(found);
      const client = record(input);
      clients.set(client.id, client);
      return withoutHash(client);
    },
    async findActiveByTokenHash(input) {
      const client = [...clients.values()].find(
        (candidate) =>
          candidate.instanceId === input.instanceId &&
          candidate.tokenHash === input.tokenHash,
      );
      return client && active(client, input.now) ? withoutHash(client) : null;
    },
    async createAuthorized(input) {
      await beforeCreate?.();
      if (
        input.client.instanceId !== instanceId ||
        !manager(input.authorizerId, input.now)
      )
        return null;
      const client = record(input.client);
      clients.set(client.id, client);
      return withoutHash(client);
    },
    async listAuthorized(input) {
      if (
        input.instanceId !== instanceId ||
        !manager(input.authorizerId, input.now)
      )
        return null;
      return [...clients.values()].map(withoutHash);
    },
    async revokeAuthorized(input) {
      if (
        input.instanceId !== instanceId ||
        !manager(input.authorizerId, input.now)
      )
        return "unauthorized";
      const client = clients.get(input.clientId);
      if (!client || client.instanceId !== input.instanceId) return "missing";
      if (client.kind === "desktop") return "desktop";
      client.revokedAt ??= input.now.toISOString();
      return "revoked";
    },
  };
  const options = {
    store,
    instance,
    allowedOrigins: ["http://127.0.0.1:3000", "http://localhost:3000"],
    readGovernance: async () => ({
      ticketTtlMs: 5_000,
      sessionMaxAgeMs: 60_000,
    }),
    now: () => timestamp,
  };
  const service = createLocalAccessService(options);
  await service.initialize();
  const token = await service.getDesktopToken();
  const request: LocalAccessRequest = {
    ip: "127.0.0.1",
    headers: { authorization: `Bearer ${token}` },
  };
  return {
    service,
    options,
    store,
    clients,
    request,
    token,
    instanceId,
    dataDir,
    advance(ms: number) {
      timestamp += ms;
    },
    pauseCreate(callback: (() => Promise<void>) | undefined) {
      beforeCreate = callback;
    },
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}
