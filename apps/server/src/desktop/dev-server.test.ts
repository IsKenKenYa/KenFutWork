import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

it.skipIf(process.platform === "win32")(
  "开发监督进程收到TERM时结束真实watcher及其服务子进程",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "kfw-dev-supervisor-"));
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string")
      throw new Error("没有测试端口");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    await mkdir(join(directory, "src"));
    await symlink(
      new URL("../../node_modules/", import.meta.url).pathname,
      join(directory, "node_modules"),
    );
    await writeFile(
      join(directory, "src", "server.ts"),
      `
import { createServer } from 'node:net';
const server=createServer().listen(${port},'127.0.0.1',()=>console.log('CHILD_READY:'+process.pid));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`,
    );
    const parent = spawn(
      process.execPath,
      [new URL("../../scripts/dev-server.mjs", import.meta.url).pathname],
      {
        cwd: directory,
        env: {
          ...process.env,
          KENFUTWORK_SERVER_PORT: String(port),
          HOST: "127.0.0.1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    let childPid: number | undefined;
    parent.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    try {
      await vi.waitFor(
        () => {
          childPid = Number(output.match(/CHILD_READY:(\d+)/)?.[1]);
          expect(childPid).toBeGreaterThan(0);
        },
        { timeout: 10_000 },
      );
      parent.kill("SIGTERM");
      await vi.waitFor(
        () => expect(parent.exitCode ?? parent.signalCode).not.toBeNull(),
        { timeout: 2_000 },
      );
      await expect(
        new Promise((resolve) => {
          const socket = connect(port, "127.0.0.1");
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => resolve(false));
        }),
      ).resolves.toBe(false);
    } finally {
      if (childPid && parent.exitCode === null && parent.signalCode === null) {
        try {
          process.kill(childPid, "SIGTERM");
        } catch {}
      }
      if (parent.exitCode === null && parent.signalCode === null) {
        const exit = once(parent, "exit");
        parent.kill("SIGKILL");
        await exit;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
