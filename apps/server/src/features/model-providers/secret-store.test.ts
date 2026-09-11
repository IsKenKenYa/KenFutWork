import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { decryptSecret, encryptSecret, maskSecret } from "./secret-store.js";

const env: ServerEnv = {
  agentBackendMode: "state",
  agentModel: "test-model",
  credentialSecret: "test-master-secret",
  port: 0,
  version: "test",
  webOrigin: "http://localhost:3000",
};

describe("SecretStore（DEC-7 服务端加密落库）", () => {
  it("加解密往返一致", () => {
    const ciphertext = encryptSecret(env, "sk-user-key-123456");
    expect(ciphertext).not.toContain("sk-user-key-123456");
    expect(decryptSecret(env, ciphertext)).toBe("sk-user-key-123456");
  });

  it("同一明文两次加密产生不同密文（随机 IV）但都可解密", () => {
    const a = encryptSecret(env, "same-key");
    const b = encryptSecret(env, "same-key");
    expect(a).not.toBe(b);
    expect(decryptSecret(env, a)).toBe("same-key");
    expect(decryptSecret(env, b)).toBe("same-key");
  });

  it("缺 credentialSecret 时加密/解密都 fail loud", () => {
    const noSecret: { credentialSecret?: string } = {};
    expect(() => encryptSecret(noSecret, "k")).toThrow(
      /LOOMIC_CREDENTIAL_SECRET 未配置/,
    );
    const ciphertext = encryptSecret(env, "k");
    expect(() => decryptSecret(noSecret, ciphertext)).toThrow(
      /LOOMIC_CREDENTIAL_SECRET 未配置/,
    );
  });

  it("篡改密文与非法格式被拒绝", () => {
    const ciphertext = encryptSecret(env, "k");
    const tampered = `${ciphertext.slice(0, -2)}xy`;
    expect(() => decryptSecret(env, tampered)).toThrow();
    expect(() => decryptSecret(env, "plaintext")).toThrow(/版本无法识别/);
    expect(() => decryptSecret(env, "v1:broken")).toThrow(/格式非法/);
  });

  it("maskSecret 脱敏不泄露中间段", () => {
    expect(maskSecret("sk-abcdef123456")).toBe("sk-a***3456");
    expect(maskSecret("short")).toBe("***");
    expect(maskSecret("")).toBe("***");
  });
});
