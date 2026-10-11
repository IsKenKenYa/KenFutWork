import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { acquireDesktopServerOwner } from "./server-owner.js";

it("同实例启动互斥、不同目录独立，正常关闭幂等并允许再启动", async () => {
  const first = await mkdtemp(join(tmpdir(), "kfw-server-owner-"));
  const second = await mkdtemp(join(tmpdir(), "kfw-server-owner-"));
  const owner = acquireDesktopServerOwner(first);
  const other = acquireDesktopServerOwner(second);
  try {
    expect(() => acquireDesktopServerOwner(first)).toThrow(/已有服务进程/);
    owner.close();
    owner.close();
    const next = acquireDesktopServerOwner(first);
    next.close();
  } finally {
    owner.close();
    other.close();
    await Promise.all(
      [first, second].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});

it("真实另一进程持有期间拒绝，强杀后操作系统释放锁且可恢复", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kfw-server-owner-"));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      new URL("./fixtures/server-owner.ts", import.meta.url).pathname,
      directory,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  try {
    if (!child.stdout) throw new Error("验收子进程缺少输出管道");
    await once(child.stdout, "data");
    expect(() => acquireDesktopServerOwner(directory)).toThrow(/已有服务进程/);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const recovered = acquireDesktopServerOwner(directory);
    recovered.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
