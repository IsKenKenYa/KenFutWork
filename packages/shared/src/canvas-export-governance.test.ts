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

const key = "canvasExportMaxBytes";
const envKey = "KENFUTWORK_CANVAS_EXPORT_MAX_BYTES";

describe("画布导出总量预算治理", () => {
  it("默认256MiB，设置与runtime采用同一整数区间", () => {
    expect(AGENT_GOVERNANCE_DEFAULTS[key]).toBe(268_435_456);
    expect(AGENT_GOVERNANCE_LIMITS[key]).toEqual({
      min: 1_024,
      max: 1_073_741_824,
    });
    expect(RUNTIME_GOVERNANCE_KEYS).toContain(key);
    expect(governanceSetting(key).parse(undefined)).toBe(268_435_456);
    expect(instanceSettingsSchema.parse({ defaultModel: "" })[key]).toBe(
      268_435_456,
    );
    for (const value of [1_024, 268_435_456, 1_073_741_824]) {
      expect(governanceSetting(key).parse(value)).toBe(value);
    }
    for (const value of [
      0,
      -1,
      1_023,
      1_024.5,
      1_073_741_825,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(governanceSetting(key).safeParse(value).success).toBe(false);
      expect(
        instanceSettingsUpdateRequestSchema.safeParse({ [key]: value }).success,
      ).toBe(false);
    }
  });

  it("库值优先于env与默认，读侧将旧越界值钳回护栏", () => {
    const overrides = resolveGovernanceEnvOverrides({ [envKey]: "536870912" });
    expect(resolveGovernanceNumber(key, undefined)).toBe(268_435_456);
    expect(resolveGovernanceNumber(key, null, overrides)).toBe(536_870_912);
    expect(resolveGovernanceNumber(key, 2_048, overrides)).toBe(2_048);
    expect(resolveGovernanceNumber(key, 0, overrides)).toBe(1_024);
    expect(resolveGovernanceNumber(key, 1_073_741_825, overrides)).toBe(
      1_073_741_824,
    );
    expect(resolveGovernanceNumber(key, 2_048.5, overrides)).toBe(2_048);
  });

  it("env只接受正的安全整数字符串，合法越界值在读侧clamp", () => {
    expect(resolveGovernanceEnvOverrides({ [envKey]: " +268435456 " })).toEqual(
      { [key]: 268_435_456 },
    );
    for (const value of [
      "",
      " ",
      "0",
      "-1",
      "256MiB",
      "1.5",
      "1e3",
      "9007199254740993",
    ]) {
      const invalid = resolveGovernanceEnvOverrides({ [envKey]: value });
      expect(invalid).not.toHaveProperty(key);
      expect(resolveGovernanceNumber(key, null, invalid)).toBe(268_435_456);
    }
    expect(
      resolveGovernanceNumber(
        key,
        null,
        resolveGovernanceEnvOverrides({ [envKey]: "1" }),
      ),
    ).toBe(1_024);
    expect(
      resolveGovernanceNumber(
        key,
        null,
        resolveGovernanceEnvOverrides({ [envKey]: "1073741825" }),
      ),
    ).toBe(1_073_741_824);
  });

  it("单字段PATCH保留送来的预算，不注入其余治理默认", () => {
    expect(instanceSettingsUpdateRequestSchema.parse({ [key]: 4_096 })).toEqual(
      {
        [key]: 4_096,
      },
    );
    expect(instanceSettingsUpdateRequestSchema.parse({})).toEqual({});
    expect(
      instanceSettingsUpdateRequestSchema.parse({ compactKeepMessages: 5 }),
    ).toEqual({ compactKeepMessages: 5 });
  });
});
