import { expect, it } from "vitest";
import { instanceSettingsSchema } from "./contracts.js";
import {
  RUNTIME_GOVERNANCE_KEYS,
  resolveGovernanceEnvOverrides,
  resolveGovernanceNumber,
} from "./governance.js";

const key = "taskAutoArchiveScanIntervalMs";
const envKey = "KENFUTWORK_TASK_AUTO_ARCHIVE_SCAN_INTERVAL_MS";

it("归档扫描间隔默认一小时，库优先env，空库落env或默认并统一护栏", () => {
  expect(
    instanceSettingsSchema.parse({ defaultModel: "fixture-model" })[key],
  ).toBe(3_600_000);
  expect(RUNTIME_GOVERNANCE_KEYS).toContain(key);
  const overrides = resolveGovernanceEnvOverrides({ [envKey]: " 600000 " });
  expect(resolveGovernanceNumber(key, 60_000, overrides)).toBe(60_000);
  expect(resolveGovernanceNumber(key, null, overrides)).toBe(600_000);
  expect(resolveGovernanceNumber(key, undefined, {})).toBe(3_600_000);
  expect(resolveGovernanceNumber(key, 1, overrides)).toBe(10_000);
  expect(resolveGovernanceNumber(key, 86_400_001, overrides)).toBe(86_400_000);
  expect(
    instanceSettingsSchema.safeParse({
      defaultModel: "fixture-model",
      [key]: 9_999,
    }).success,
  ).toBe(false);
  expect(
    instanceSettingsSchema.safeParse({
      defaultModel: "fixture-model",
      [key]: 1_000.5,
    }).success,
  ).toBe(false);
});

it.each(["", "abc", "10000oops", "10000.5", "1e3", "Infinity"])(
  "归档扫描间隔非法env %s忽略，不改变库值或默认",
  (value) => {
    const overrides = resolveGovernanceEnvOverrides({ [envKey]: value });
    expect(overrides).not.toHaveProperty(key);
    expect(resolveGovernanceNumber(key, null, overrides)).toBe(3_600_000);
    expect(resolveGovernanceNumber(key, 120_000, overrides)).toBe(120_000);
  },
);
