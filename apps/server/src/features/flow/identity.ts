import { createHash } from "node:crypto";

import { generateLocalAccessToken } from "../local-access/desktop-token.js";

/**
 * flow 宿主身份票据（本地实例身份适配，《flow 集成方案》§3.2 身份缝）。
 *
 * 形状与「本机接入 connect 票据」同源：内存 Map + 哈希存储 + 一次性消费 + 短 TTL
 * （治理值沿用 `localAccessTicketTtlMs`）。不用 HMAC 自包含令牌的理由：票据只活在一次
 * 握手里（毫秒级到分钟内），进程内查表更简单，也天然带「消费即失效」；服务重启票据
 * 作废，由 iframe 重握手覆盖（重新签发）。
 */

export interface FlowIdentityTickets {
  issue(input: {
    /** 稳定归属：本地实例模型下即实例 instanceId。 */
    instanceId: string;
    /** 哪个接入客户端换的（审计用；身份 subject 只取 instanceId）。 */
    accessClientId: string | null;
    ttlMs: number;
  }): { token: string; expiresAt: string };
  /** 消费票据（一次性）：未知/过期/已用过一律返回 null。 */
  consume(token: string): {
    instanceId: string;
    accessClientId: string | null;
  } | null;
}

export function createFlowIdentityTickets(
  options: { now?: () => number } = {},
): FlowIdentityTickets {
  const now = options.now ?? Date.now;
  const tickets = new Map<
    string,
    { instanceId: string; accessClientId: string | null; expiresAt: number }
  >();
  const digest = (token: string) =>
    createHash("sha256").update(token, "utf8").digest("hex");
  const purge = () => {
    const timestamp = now();
    for (const [key, entry] of tickets) {
      if (entry.expiresAt <= timestamp) tickets.delete(key);
    }
  };

  return {
    issue(input) {
      purge();
      const token = generateLocalAccessToken();
      const expiresAt = now() + input.ttlMs;
      tickets.set(digest(token), {
        instanceId: input.instanceId,
        accessClientId: input.accessClientId,
        expiresAt,
      });
      return { token, expiresAt: new Date(expiresAt).toISOString() };
    },

    consume(token) {
      purge();
      const key = digest(token);
      const entry = tickets.get(key);
      if (!entry) return null;
      // 一次性：必须在返回前删除（并发消费 first-wins，同本机接入 connect 票据）。
      tickets.delete(key);
      return {
        instanceId: entry.instanceId,
        accessClientId: entry.accessClientId,
      };
    },
  };
}
