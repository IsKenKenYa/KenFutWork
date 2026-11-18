import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { signBlobUrl } from "./providers/local-fs.js";
import { ensureBlobSigningKey } from "./signing-key.js";

describe("本地对象签名密钥", () => {
  it("重启与接入凭据轮换后保持签名，独立实例不共享密钥", () => {
    const root = mkdtempSync(join(tmpdir(), "kfw-blob-key-"));
    try {
      const key = ensureBlobSigningKey(root);
      const payload = { bucket: "uploads", path: "example", expiresAt: 100 };
      const signature = signBlobUrl({ ...payload, signingSecret: key });
      writeFileSync(join(root, "desktop-access-token"), "new-access-token");
      expect(ensureBlobSigningKey(root)).toBe(key);
      expect(
        signBlobUrl({ ...payload, signingSecret: ensureBlobSigningKey(root) }),
      ).toBe(signature);
      expect(ensureBlobSigningKey(join(root, "another-instance"))).not.toBe(
        key,
      );
      expect(readFileSync(join(root, "blob-signing-key"), "utf8")).toBe(key);
      if (process.platform !== "win32") {
        expect(statSync(join(root, "blob-signing-key")).mode & 0o777).toBe(
          0o600,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("损坏文件启动失败，保留原文件以便诊断", () => {
    const root = mkdtempSync(join(tmpdir(), "kfw-blob-key-"));
    try {
      writeFileSync(join(root, "blob-signing-key"), "damaged");
      expect(() => ensureBlobSigningKey(root)).toThrow("格式损坏");
      expect(readFileSync(join(root, "blob-signing-key"), "utf8")).toBe(
        "damaged",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
