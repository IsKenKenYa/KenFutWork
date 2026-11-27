import { describe, expect, it } from "vitest";
import { instanceSettingsSchema } from "./contracts.js";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  AGENT_GOVERNANCE_LIMITS,
  governanceSetting,
  RUNTIME_GOVERNANCE_KEYS,
  resolveGovernanceEnvOverrides,
  resolveGovernanceNumber,
} from "./governance.js";
import { instanceSettingsUpdateRequestSchema } from "./http.js";

const CASES = [
  {
    key: "mcpMarketplaceFetchTimeoutMs",
    envKey: "KENFUTWORK_MCP_MARKETPLACE_FETCH_TIMEOUT_MS",
    fallback: "15000",
    min: 1_000,
    max: 120_000,
  },
  {
    key: "mcpMarketplaceReadMaxBytes",
    envKey: "KENFUTWORK_MCP_MARKETPLACE_READ_MAX_BYTES",
    fallback: "2097152",
    min: 262_144,
    max: 16_777_216,
  },
  {
    key: "mcpMarketplaceCacheTtlMs",
    envKey: "KENFUTWORK_MCP_MARKETPLACE_CACHE_TTL_MS",
    fallback: "21600000",
    min: 60_000,
    max: 604_800_000,
  },
  {
    key: "mcpMarketplaceFetchConcurrency",
    envKey: "KENFUTWORK_MCP_MARKETPLACE_FETCH_CONCURRENCY",
    fallback: "12",
    min: 1,
    max: 32,
  },
] as const;

describe("MCP 市场治理", () => {
  it("四项数值登记在运行时治理表，设置读取返回默认值", () => {
    const settings = instanceSettingsSchema.parse({ defaultModel: "" });
    for (const entry of CASES) {
      expect(AGENT_GOVERNANCE_LIMITS[entry.key]).toEqual({
        min: entry.min,
        max: entry.max,
      });
      expect(RUNTIME_GOVERNANCE_KEYS).toContain(entry.key);
      expect(AGENT_GOVERNANCE_DEFAULTS[entry.key]).toBe(Number(entry.fallback));
      expect(settings[entry.key]).toBe(Number(entry.fallback));
    }
  });

  it("区间内的整数被接受，越界值与小数被设置接口拒绝", () => {
    for (const entry of CASES) {
      for (const value of [entry.min, entry.max]) {
        expect(governanceSetting(entry.key).parse(value)).toBe(value);
        expect(
          instanceSettingsUpdateRequestSchema.safeParse({ [entry.key]: value })
            .success,
        ).toBe(true);
      }
      for (const value of [
        entry.min - 1,
        entry.max + 1,
        entry.min + 0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        expect(governanceSetting(entry.key).safeParse(value).success).toBe(
          false,
        );
        expect(
          instanceSettingsUpdateRequestSchema.safeParse({ [entry.key]: value })
            .success,
        ).toBe(false);
      }
    }
  });

  it("库值优先于环境变量与默认值，旧的越界库值读回时收进区间", () => {
    for (const entry of CASES) {
      const overrides = resolveGovernanceEnvOverrides({
        [entry.envKey]: String(entry.max),
      });
      expect(resolveGovernanceNumber(entry.key, undefined)).toBe(
        Number(entry.fallback),
      );
      expect(resolveGovernanceNumber(entry.key, null, overrides)).toBe(
        entry.max,
      );
      expect(resolveGovernanceNumber(entry.key, entry.min, overrides)).toBe(
        entry.min,
      );
      expect(resolveGovernanceNumber(entry.key, entry.min - 1)).toBe(entry.min);
      expect(resolveGovernanceNumber(entry.key, entry.max + 1)).toBe(entry.max);
    }
  });

  it("环境变量只接受整数字符串，写错的值被忽略", () => {
    for (const entry of CASES) {
      expect(
        resolveGovernanceEnvOverrides({
          [entry.envKey]: ` +${entry.fallback} `,
        }),
      ).toEqual({ [entry.key]: Number(entry.fallback) });
      for (const value of ["", " ", "1.5", "1e3", "2MiB", "9007199254740993"]) {
        const overrides = resolveGovernanceEnvOverrides({
          [entry.envKey]: value,
        });
        expect(overrides).not.toHaveProperty(entry.key);
        expect(resolveGovernanceNumber(entry.key, null, overrides)).toBe(
          Number(entry.fallback),
        );
      }
      expect(
        resolveGovernanceNumber(
          entry.key,
          null,
          resolveGovernanceEnvOverrides({ [entry.envKey]: "0" }),
        ),
      ).toBe(entry.min);
    }
  });

  it("只改一项时其余三项保持原值", () => {
    const key = "mcpMarketplaceFetchConcurrency";
    expect(instanceSettingsUpdateRequestSchema.parse({ [key]: 6 })).toEqual({
      [key]: 6,
    });
    expect(instanceSettingsUpdateRequestSchema.parse({})).toEqual({});
  });
});
