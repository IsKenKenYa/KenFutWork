import { expect, it } from "vitest";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  AGENT_GOVERNANCE_LIMITS,
  governanceSetting,
  RUNTIME_GOVERNANCE_KEYS,
  resolveGovernanceEnvOverrides,
  resolveGovernanceNumber,
} from "./governance.js";

const fields = [
  ["localAccessTicketTtlMs", 60_000],
  ["localAccessSessionMaxAgeMs", 2_592_000_000],
  ["localDataMigrationPollMs", 250],
  ["localServiceStartupTimeoutMs", 120_000],
  ["localServiceStartupPollMs", 1_000],
] as const;

it.each(fields)("%s的默认、持久设置与运行时护栏一致", (key, fallback) => {
  const setting = governanceSetting(key);
  const { min, max } = AGENT_GOVERNANCE_LIMITS[key];
  expect(AGENT_GOVERNANCE_DEFAULTS[key]).toBe(fallback);
  expect(setting.parse(undefined)).toBe(fallback);
  expect(RUNTIME_GOVERNANCE_KEYS).toContain(key);
  expect(setting.parse(min)).toBe(min);
  expect(setting.parse(max)).toBe(max);
  expect(resolveGovernanceNumber(key, undefined)).toBe(fallback);
  expect(resolveGovernanceNumber(key, min - 1)).toBe(min);
  expect(resolveGovernanceNumber(key, max + 1)).toBe(max);
  for (const value of [min - 1, max + 1, min + 0.5]) {
    expect(setting.safeParse(value).success).toBe(false);
  }
});

const envFields = [
  ["localAccessTicketTtlMs", "KENFUTWORK_LOCAL_ACCESS_TICKET_TTL_MS"],
  ["localAccessSessionMaxAgeMs", "KENFUTWORK_LOCAL_ACCESS_SESSION_MAX_AGE_MS"],
  ["localDataMigrationPollMs", "KENFUTWORK_LOCAL_DATA_MIGRATION_POLL_MS"],
  [
    "localServiceStartupTimeoutMs",
    "KENFUTWORK_LOCAL_SERVICE_STARTUP_TIMEOUT_MS",
  ],
  ["localServiceStartupPollMs", "KENFUTWORK_LOCAL_SERVICE_STARTUP_POLL_MS"],
] as const;

it.each(envFields)(
  "%s启动前env可覆盖，接通后的库值仍优先且非法env忽略",
  (key, name) => {
    const { min, max } = AGENT_GOVERNANCE_LIMITS[key];
    const overrides = resolveGovernanceEnvOverrides({ [name]: ` ${max} ` });
    expect(overrides).toEqual({ [key]: max });
    expect(resolveGovernanceNumber(key, null, overrides)).toBe(max);
    expect(resolveGovernanceNumber(key, min, overrides)).toBe(min);
    for (const value of ["1oops", "1.5", "1e3", "9007199254740993"]) {
      const invalid = resolveGovernanceEnvOverrides({ [name]: value });
      expect(invalid).not.toHaveProperty(key);
      expect(resolveGovernanceNumber(key, null, invalid)).toBe(
        AGENT_GOVERNANCE_DEFAULTS[key],
      );
    }
  },
);
