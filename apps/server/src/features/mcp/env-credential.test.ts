import { describe, expect, it } from "vitest";

import { createMcpEnvCredentialReader } from "./env-credential.js";

/**
 * jev 凭据复用缝：只按「服务器名 + env 键」取单值，不枚举整个 env。
 */
describe("MCP env 凭据只读缝", () => {
  const configurations = [
    {
      name: "jev",
      enabled: true,
      env: { TYPESAFE_API_KEY: "ts-key-123", OTHER: "x" },
    },
    {
      name: "filesystem-test",
      enabled: true,
      env: {},
    },
    {
      name: "disabled-jev",
      enabled: false,
      env: { TYPESAFE_API_KEY: "should-not-read" },
    },
  ];

  it("按名取到已启用条目的 key", async () => {
    const reader = createMcpEnvCredentialReader({
      readConfigurations: async () => configurations,
    });
    expect(await reader.readEnvValue("jev", "TYPESAFE_API_KEY")).toBe(
      "ts-key-123",
    );
  });

  it("条目不存在 / 已停用 / 键缺失 都返回 null", async () => {
    const reader = createMcpEnvCredentialReader({
      readConfigurations: async () => configurations,
    });
    expect(await reader.readEnvValue("nope", "TYPESAFE_API_KEY")).toBeNull();
    expect(
      await reader.readEnvValue("disabled-jev", "TYPESAFE_API_KEY"),
    ).toBeNull();
    expect(await reader.readEnvValue("jev", "NOPE_KEY")).toBeNull();
  });

  it("空字符串 / 纯空白不当作有效凭据", async () => {
    const reader = createMcpEnvCredentialReader({
      readConfigurations: async () => [
        { name: "jev", enabled: true, env: { TYPESAFE_API_KEY: "   " } },
      ],
    });
    expect(await reader.readEnvValue("jev", "TYPESAFE_API_KEY")).toBeNull();
  });
});
