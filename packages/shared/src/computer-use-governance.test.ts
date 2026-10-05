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
  ["computerUseAxMaxDepth", "KENFUTWORK_COMPUTER_USE_AX_MAX_DEPTH", 8],
  ["computerUseAxMaxChildren", "KENFUTWORK_COMPUTER_USE_AX_MAX_CHILDREN", 120],
  [
    "computerUseAxTitleMaxChars",
    "KENFUTWORK_COMPUTER_USE_AX_TITLE_MAX_CHARS",
    200,
  ],
  [
    "computerUseAxValueMaxChars",
    "KENFUTWORK_COMPUTER_USE_AX_VALUE_MAX_CHARS",
    300,
  ],
  ["computerUseAxMaxActions", "KENFUTWORK_COMPUTER_USE_AX_MAX_ACTIONS", 12],
  ["computerUseInputDelayMs", "KENFUTWORK_COMPUTER_USE_INPUT_DELAY_MS", 100],
  [
    "computerUseMcpKeepAliveMs",
    "KENFUTWORK_COMPUTER_USE_MCP_KEEP_ALIVE_MS",
    15_000,
  ],
] as const;

it.each(fields)(
  "%s设置默认及整数护栏一致，边界可保存而越界拒绝",
  (key, _envKey, fallback) => {
    const { min, max } = AGENT_GOVERNANCE_LIMITS[key];
    const setting = governanceSetting(key);
    expect(AGENT_GOVERNANCE_DEFAULTS[key]).toBe(fallback);
    expect(setting.parse(undefined)).toBe(fallback);
    expect(RUNTIME_GOVERNANCE_KEYS).toContain(key);
    expect(setting.parse(min)).toBe(min);
    expect(setting.parse(max)).toBe(max);
    for (const invalid of [min - 1, max + 1, min + 0.5]) {
      expect(setting.safeParse(invalid).success).toBe(false);
    }
  },
);

it.each(fields)(
  "%s读取优先库值再env再默认，输入统一钳回护栏",
  (key, envKey, fallback) => {
    const { min, max } = AGENT_GOVERNANCE_LIMITS[key];
    const env = resolveGovernanceEnvOverrides({ [envKey]: ` +${max} ` });
    expect(env).toEqual({ [key]: max });
    expect(resolveGovernanceNumber(key, min, env)).toBe(min);
    expect(resolveGovernanceNumber(key, null, env)).toBe(max);
    expect(resolveGovernanceNumber(key, undefined, {})).toBe(fallback);
    expect(resolveGovernanceNumber(key, max + 1, env)).toBe(max);
    expect(resolveGovernanceNumber(key, min - 1, env)).toBe(min);
  },
);

it.each([
  "",
  "abc",
  "100oops",
  "100.5",
  "1e3",
  "Infinity",
  "9007199254740993",
  "0x10",
])("非法env %s整体忽略，不接受部分整数或不安全整数", (raw) => {
  const env = resolveGovernanceEnvOverrides(
    Object.fromEntries(fields.map(([, key]) => [key, raw])),
  );
  expect(env).toEqual({});
  for (const [key, , fallback] of fields) {
    expect(resolveGovernanceNumber(key, null, env)).toBe(fallback);
  }
});
