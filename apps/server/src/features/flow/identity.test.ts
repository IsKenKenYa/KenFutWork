import { describe, expect, it } from "vitest";

import { LOCAL_ACCESS_TOKEN_PATTERN } from "../local-access/desktop-token.js";
import { createFlowIdentityTickets } from "./identity.js";

const INSTANCE = "11111111-1111-4111-8111-111111111111";

describe("flow 宿主身份票据", () => {
  it("签发的票据消费一次即得归属；令牌形状与本机接入一致", () => {
    const tickets = createFlowIdentityTickets();
    const { token, expiresAt } = tickets.issue({
      instanceId: INSTANCE,
      accessClientId: "client-1",
      ttlMs: 60_000,
    });
    expect(LOCAL_ACCESS_TOKEN_PATTERN.test(token)).toBe(true);
    expect(Number.isFinite(Date.parse(expiresAt))).toBe(true);
    expect(tickets.consume(token)).toEqual({
      instanceId: INSTANCE,
      accessClientId: "client-1",
    });
  });

  it("一次性：同一票据重放拿不到第二次（不能借重放拿身份）", () => {
    const tickets = createFlowIdentityTickets();
    const { token } = tickets.issue({
      instanceId: INSTANCE,
      accessClientId: null,
      ttlMs: 60_000,
    });
    expect(tickets.consume(token)).not.toBeNull();
    expect(tickets.consume(token)).toBeNull();
  });

  it("过期即无效；未知令牌无效", () => {
    let timestamp = 1_000;
    const tickets = createFlowIdentityTickets({ now: () => timestamp });
    const { token } = tickets.issue({
      instanceId: INSTANCE,
      accessClientId: null,
      ttlMs: 5_000,
    });
    timestamp = 6_000;
    expect(tickets.consume(token)).toBeNull();
    expect(tickets.consume("forged-token")).toBeNull();
  });

  it("过期票据被清理，不随签发无限堆积", () => {
    let timestamp = 1_000;
    const tickets = createFlowIdentityTickets({ now: () => timestamp });
    for (let index = 0; index < 100; index += 1) {
      tickets.issue({
        instanceId: INSTANCE,
        accessClientId: null,
        ttlMs: 1_000,
      });
      timestamp += 100;
    }
    // 全部过期后再签一张：旧票据在 purge 里清掉，新票据照常工作。
    timestamp += 10_000;
    const fresh = tickets.issue({
      instanceId: INSTANCE,
      accessClientId: null,
      ttlMs: 5_000,
    });
    expect(tickets.consume(fresh.token)).not.toBeNull();
  });
});
