import { expect, it } from "vitest";
import {
  codeUiEventSchema,
  zcodeUiProtocol as protocol,
} from "./code-ui-contracts.js";
import { workspaceSettingsSchema } from "./contracts.js";
import {
  clampCodeUiReconnectDelayMs,
  RUNTIME_GOVERNANCE_KEYS,
  resolveGovernanceEnvOverrides,
  resolveGovernanceNumber,
} from "./governance.js";

const key = "codeUiReconnectDelayMs";
const envKey = "KENFUTWORK_CODE_UI_RECONNECT_DELAY_MS";

it("Code重连间隔默认与工作区JSON治理一致，库优先env，空库落env或默认并统一护栏", () => {
  expect(workspaceSettingsSchema.parse({ defaultModel: "fixture-model" })[key]).toBe(1_000);
  expect(RUNTIME_GOVERNANCE_KEYS).toContain(key);
  const overrides = resolveGovernanceEnvOverrides({ [envKey]: " 2000 " });
  expect(resolveGovernanceNumber(key, 5_000, overrides)).toBe(5_000);
  expect(resolveGovernanceNumber(key, null, overrides)).toBe(2_000);
  expect(resolveGovernanceNumber(key, undefined, {})).toBe(1_000);
  expect(resolveGovernanceNumber(key, 1, overrides)).toBe(100);
  expect(resolveGovernanceNumber(key, 100_000, overrides)).toBe(60_000);
  expect(clampCodeUiReconnectDelayMs(999.9)).toBe(999);
  expect(clampCodeUiReconnectDelayMs(Number.NaN)).toBe(100);
  expect(workspaceSettingsSchema.safeParse({ defaultModel: "fixture-model", [key]: 99 }).success).toBe(false);
  expect(workspaceSettingsSchema.safeParse({ defaultModel: "fixture-model", [key]: 60_001 }).success).toBe(
    false,
  );
});

it.each([
  "",
  "abc",
  "1000oops",
  "1000.5",
  "1e3",
  "Infinity",
  "9007199254740993",
])(
  "Code重连非法env %s忽略，不让parseInt部分接受或不安全整数改变兜底",
  (value) => {
    const overrides = resolveGovernanceEnvOverrides({ [envKey]: value });
    expect(overrides).not.toHaveProperty(key);
    expect(resolveGovernanceNumber(key, null, overrides)).toBe(1_000);
    expect(resolveGovernanceNumber(key, 3_000, overrides)).toBe(3_000);
  },
);

it("ready接受有效重连metadata并拒绝越界值，旧帧缺字段不伪装成默认配置", () => {
  const ready = {
    event: "ready",
    hello: {
      kind: "hello",
      protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
      connectionId: "owned-connection",
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
      serverTime: 1,
      auth: { userId: "owner" },
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none",
      },
    },
  };
  expect(codeUiEventSchema.parse(ready)).not.toHaveProperty("reconnectDelayMs");
  for (const delay of [100, 2_000, 60_000]) {
    expect(
      codeUiEventSchema.parse({ ...ready, reconnectDelayMs: delay }),
    ).toMatchObject({ reconnectDelayMs: delay });
  }
  for (const delay of [99, 60_001, 1_000.5]) {
    expect(
      codeUiEventSchema.safeParse({ ...ready, reconnectDelayMs: delay })
        .success,
    ).toBe(false);
  }
});
