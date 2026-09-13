import { describe, expect, it } from "vitest";

import {
  generateSessionToken,
  hashPassword,
  PasswordHashError,
  verifyPassword,
} from "./password.js";

describe("口令哈希（scrypt，自描述格式）", () => {
  it("同一口令两次哈希不同（盐随机），但都能校验通过", async () => {
    const first = await hashPassword("correct horse battery");
    const second = await hashPassword("correct horse battery");

    expect(first).not.toBe(second);
    expect(first.startsWith("scrypt$")).toBe(true);
    await expect(verifyPassword("correct horse battery", first)).resolves.toBe(
      true,
    );
    await expect(verifyPassword("correct horse battery", second)).resolves.toBe(
      true,
    );
  });

  it("错误口令不通过；大小写敏感", async () => {
    const stored = await hashPassword("Secret123!");
    await expect(verifyPassword("Secret123", stored)).resolves.toBe(false);
    await expect(verifyPassword("secret123!", stored)).resolves.toBe(false);
    await expect(verifyPassword("", stored)).resolves.toBe(false);
  });

  it("空口令不予哈希（调用方须先校验长度）", async () => {
    await expect(hashPassword("")).rejects.toBeInstanceOf(PasswordHashError);
  });

  it("哈希串里的参数被采用：改默认参数不影响历史行的校验", async () => {
    // 用较小的 N 造一条「历史」哈希，再用当前默认参数校验，应仍然通过
    const legacy = await hashPassword("legacy-password", { N: 1024 });
    expect(legacy.split("$")[1]).toBe("1024");
    await expect(verifyPassword("legacy-password", legacy)).resolves.toBe(true);
  });

  it("畸形哈希串一律判失败（不抛错、不误判通过）", async () => {
    const cases = [
      "",
      "not-a-hash",
      "scrypt$16384$8$1$onlyfive",
      "scrypt$16384$8$1$aGk=$",
      "bcrypt$16384$8$1$aGk=$aGk=",
      // 参数越界（构造出的天价计算 / 非法值）
      `scrypt$99999999$8$1$aGk=$aGk=`,
      `scrypt$1$8$1$aGk=$aGk=`,
      `scrypt$16384$0$1$aGk=$aGk=`,
      `scrypt$16384$8$0$aGk=$aGk=`,
      `scrypt$abc$8$1$aGk=$aGk=`,
    ];

    for (const stored of cases) {
      await expect(verifyPassword("whatever", stored)).resolves.toBe(false);
    }
  });

  it("会话令牌是 256 位随机串且互不相同", () => {
    const tokens = new Set(
      Array.from({ length: 64 }, () => generateSessionToken()),
    );

    expect(tokens.size).toBe(64);
    for (const token of tokens) {
      expect(token.length).toBeGreaterThanOrEqual(42);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});
