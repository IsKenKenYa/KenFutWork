import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createProcessSandbox } from "./service.js";
import type { ManagedProcessSnapshot } from "./types.js";

const execute = promisify(execFile);
const defaults = AGENT_GOVERNANCE_DEFAULTS;
const limits = {
  maxOutputBytes: defaults.processMaxOutputBytes,
  previewMaxChars: defaults.processPreviewMaxChars,
  yieldMs: defaults.processYieldMs,
  killGraceMs: defaults.processKillGraceMs,
};

async function projectFixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-project-read-")),
  );
  const root = join(directory, "project");
  const reference = join(directory, "reference");
  await mkdir(root);
  await mkdir(reference);
  await writeFile(join(root, "main.txt"), "main");
  await writeFile(join(reference, "reference.txt"), "reference");
  const outside = join(directory, "outside.txt");
  await writeFile(outside, "outside");
  const snapshots: ManagedProcessSnapshot[] = [];
  const sandbox = createProcessSandbox({
    captureRoot: join(directory, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  return {
    directory,
    root,
    reference,
    outside,
    sandbox,
    snapshots,
    scope: {
      instanceId: randomUUID(),
      projectId: randomUUID(),
      connectionId: randomUUID(),
      revision: "0",
      rootDirectory: root,
      additionalDirectories: [reference],
    },
    async close() {
      try {
        await sandbox.close("项目读取测试结束");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

async function nodeProcesses(marker: string) {
  let candidates: string[];
  try {
    const found = await execute("pgrep", ["-f", marker]);
    candidates = found.stdout.trim().split("\n");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 1
    )
      return [];
    throw error;
  }
  const processes: number[] = [];
  for (const candidate of candidates) {
    const pid = Number(candidate);
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("系统返回了无效进程身份");
    const command = await execute("ps", ["-p", String(pid), "-o", "comm="]);
    if (basename(command.stdout.trim()) === "node") processes.push(pid);
  }
  return processes;
}

describe.skipIf(
  process.env.RUN_CODE_UI_INTEGRATION !== "1" || process.platform === "win32",
)("Project只读进程公共接口与实际OS隔离 integration", () => {
  it("读取两个授权根并保留NUL，拒绝写入、目录外读取和网络，不发布Task快照", async () => {
    const fixture = await projectFixture();
    let connections = 0;
    const server = createServer((_request, response) => {
      connections++;
      response.end();
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as AddressInfo).port;
      const lease = await fixture.sandbox.openProjectReadLease({
        scope: fixture.scope,
        limits,
      });
      const main = join(fixture.root, "main.txt");
      const reference = join(fixture.reference, "reference.txt");
      const program = `
const fs=require('node:fs'),net=require('node:net');
const denied=(action)=>{try{action();throw new Error('unexpected access')}catch(error){if(!['EACCES','EPERM','EROFS'].includes(error.code))throw error}};
const main=fs.readFileSync(${JSON.stringify(main)},'utf8');
const reference=fs.readFileSync(${JSON.stringify(reference)},'utf8');
denied(()=>fs.writeFileSync(${JSON.stringify(main)},'changed'));
denied(()=>fs.writeFileSync(${JSON.stringify(reference)},'changed'));
denied(()=>fs.readFileSync(${JSON.stringify(fixture.outside)}));
const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));
process.stdin.on('end',()=>{const socket=net.connect(${port},'127.0.0.1');
socket.on('connect',()=>{process.exitCode=9;socket.destroy()});
socket.on('error',error=>{if(!['EACCES','EPERM'].includes(error.code))throw error;
process.stdout.write(main+'/'+reference+'\\0');process.stdout.write(Buffer.concat(chunks));process.stderr.write('stderr\\0中文')});});`;
      const result = await lease.exec({
        argv: { executable: process.execPath, args: ["-e", program] },
        input: "stdin\0🙂",
        timeoutMs: 10_000, // 此次真实隔离验证的期限，不改变产品默认配置。
      });
      expect(result.exit).toMatchObject({
        exitCode: 0,
        rangeEmpty: true,
        stopped: false,
      });
      expect(result.stdout).toBe("main/reference\0stdin\0🙂");
      expect(result.stderr).toBe("stderr\0中文");
      expect(result.discardedBytes).toBe(0);
      expect(connections).toBe(0);
      expect(await readFile(main, "utf8")).toBe("main");
      expect(await readFile(reference, "utf8")).toBe("reference");
      await lease.close("读取完成");
      expect(await readdir(join(fixture.directory, "capture"))).toEqual([]);
      await expect(
        lease.exec({
          argv: { executable: process.execPath, args: ["--version"] },
        }),
      ).rejects.toMatchObject({ code: "process_closed" });
      expect(fixture.snapshots).toEqual([]);
    } finally {
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } finally {
        await fixture.close();
      }
    }
  }, 30_000); // 原ProcessSandbox接口、真实进程/文件/网络及资源清理期限。

  it("取消已启动的Project进程等待真正退出，迟到执行被拒绝", async () => {
    const fixture = await projectFixture();
    try {
      const controller = new AbortController();
      const lease = await fixture.sandbox.openProjectReadLease(
        { scope: fixture.scope, limits },
        { signal: controller.signal },
      );
      const marker = `kfw-project-read-${randomUUID()}`;
      const running = lease.exec({
        argv: {
          executable: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)", marker],
        },
        timeoutMs: 10_000, // 只界定此次真实取消测试。
      });
      const settled = running.then(
        () => null,
        (error: unknown) => error,
      );
      const pid = await vi.waitFor(
        async () => {
          const found = await nodeProcesses(marker);
          expect(found).toHaveLength(1);
          return found[0];
        },
        { timeout: 5_000 },
      );
      if (!pid) throw new Error("没有观察到实际项目读取进程");
      controller.abort(new Error("project_read_cancelled"));
      expect(await settled).toBeInstanceOf(Error);
      await lease.close("确认取消完成");
      expect(await readdir(join(fixture.directory, "capture"))).toEqual([]);
      expect(() => process.kill(pid, 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" }),
      );
      await expect(
        lease.exec({
          argv: { executable: process.execPath, args: ["--version"] },
        }),
      ).rejects.toThrow("project_read_cancelled");
      expect(fixture.snapshots).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 30_000); // 通过OS进程表确认已启动，再取消并核验退出，不以延时推断启动。
});
