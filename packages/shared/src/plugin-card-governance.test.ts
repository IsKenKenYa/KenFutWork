import { expect, it } from "vitest";
import { instanceSettingsSchema } from "./contracts.js";
import {
  RUNTIME_GOVERNANCE_KEYS,
  resolveGovernanceEnvOverrides,
  resolveGovernanceNumber,
} from "./governance.js";

const cases = [
  {
    key: "pluginCardMaxFields" as const,
    envKey: "KENFUTWORK_PLUGIN_CARD_MAX_FIELDS",
    fallback: 8,
    min: 1,
    max: 20,
  },
  {
    key: "pluginCardFieldValueMaxChars" as const,
    envKey: "KENFUTWORK_PLUGIN_CARD_FIELD_VALUE_MAX_CHARS",
    fallback: 120,
    min: 16,
    max: 2_000,
  },
];

it.each(cases)(
  "$key 默认值、库优先env、护栏与设置拒绝越界值",
  ({ key, envKey, fallback, min, max }) => {
    expect(
      instanceSettingsSchema.parse({ defaultModel: "fixture-model" })[key],
    ).toBe(fallback);
    expect(RUNTIME_GOVERNANCE_KEYS).toContain(key);
    const overrides = resolveGovernanceEnvOverrides({
      [envKey]: String(min * 2),
    });
    expect(resolveGovernanceNumber(key, min * 3, overrides)).toBe(min * 3);
    expect(resolveGovernanceNumber(key, null, overrides)).toBe(min * 2);
    expect(resolveGovernanceNumber(key, undefined, {})).toBe(fallback);
    expect(resolveGovernanceNumber(key, min - 1, overrides)).toBe(min);
    expect(resolveGovernanceNumber(key, max + 1, overrides)).toBe(max);
    expect(
      instanceSettingsSchema.safeParse({
        defaultModel: "fixture-model",
        [key]: min - 1,
      }).success,
    ).toBe(false);
    expect(
      instanceSettingsSchema.safeParse({
        defaultModel: "fixture-model",
        [key]: max + 1,
      }).success,
    ).toBe(false);
  },
);

it.each(["", "abc", "8oops", "8.5", "1e3", "Infinity"])(
  "插件卡片上限非法env %s忽略，不改变库值或默认",
  (value) => {
    for (const { key, envKey, fallback } of cases) {
      const overrides = resolveGovernanceEnvOverrides({ [envKey]: value });
      expect(overrides).not.toHaveProperty(key);
      expect(resolveGovernanceNumber(key, null, overrides)).toBe(fallback);
    }
  },
);
