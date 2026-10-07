import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ensureDesktopToken,
  LOCAL_ACCESS_TOKEN_PATTERN,
} from "./desktop-token.js";

describe("桌面凭据文件", () => {
  it("并发发布收敛为同一owner-only凭据，重启读回已有值", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kfw-token-"));
    try {
      const tokens = await Promise.all(
        Array.from({ length: 12 }, () => ensureDesktopToken(directory)),
      );
      expect(new Set(tokens).size).toBe(1);
      expect(LOCAL_ACCESS_TOKEN_PATTERN.test(tokens[0] ?? "")).toBe(true);
      const path = join(directory, "local-access", "desktop-token");
      expect(await readFile(path, "utf8")).toBe(tokens[0]);
      expect(await ensureDesktopToken(directory)).toBe(tokens[0]);
      if (process.platform !== "win32") {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(join(directory, "local-access"))).mode & 0o777).toBe(
          0o700,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("损坏凭据拒绝启动且错误不显示秘密，不能跟随凭据symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kfw-token-"));
    try {
      await ensureDesktopToken(directory);
      const path = join(directory, "local-access", "desktop-token");
      await writeFile(path, "broken-secret");
      await expect(ensureDesktopToken(directory)).rejects.toThrow(
        "本机接入凭据文件格式无效",
      );
      await rm(path);
      const target = join(directory, "elsewhere");
      await writeFile(target, "broken-secret");
      await symlink(target, path);
      await expect(ensureDesktopToken(directory)).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("broken-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
