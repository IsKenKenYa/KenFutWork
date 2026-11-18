import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 密码学密钥长度是协议强度，不是用户运行预算；与接入凭据完全独立。 */
const KEY_BYTES = 32;

export function ensureBlobSigningKey(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "blob-signing-key");
  try {
    writeFileSync(file, randomBytes(KEY_BYTES).toString("base64url"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  const key = readFileSync(file, "utf8");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(key))
    throw new Error("本地对象签名密钥格式损坏。");
  return key;
}
