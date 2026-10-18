import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  type PosixSessionIdentity,
  PtySessionRange,
} from "./pty-session-range.js";
import type { ProcessLimits } from "./types.js";

const enabled =
  process.platform === "darwin" &&
  process.env.KENFUTWORK_POSIX_SESSION_NATIVE_TESTS === "1";
const execute = promisify(execFile);
const limits: ProcessLimits = {
  maxOutputBytes: 65536,
  previewMaxChars: 8000,
  yieldMs: 20,
  killGraceMs: 2000,
};

function releaseFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = 0x52;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function environmentFrame(environment: Record<string, string>): Buffer {
  return releaseFrame(
    Buffer.from(
      Object.entries(environment)
        .map(([key, value]) => `${key}=${value}\0`)
        .join(""),
      "utf8",
    ),
  );
}

describe.skipIf(!enabled)("Darwin 私有 pipes 启动身份握手", () => {
  let root: string;
  let binary: string;
  let target: string;
  const pending: Array<{
    channel: Duplex;
    child: ReturnType<typeof spawn>;
    exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  }> = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "kfw-posix-launch-"));
    binary = join(root, "posix-session");
    target = join(root, "launch-target");
    const source = fileURLToPath(
      new URL("./native/posix-session.c", import.meta.url),
    );
    await execute("/usr/bin/cc", [
      "-std=c11",
      "-O2",
      source,
      "-lproc",
      "-o",
      binary,
    ]);
    const targetSource = join(root, "launch-target.c");
    await writeFile(
      targetSource,
      `#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 4) return 90;
  errno = 0;
  if (fcntl(3, F_GETFD) != -1 || errno != EBADF) return 88;
  FILE *marker = fopen(argv[1], "w");
  if (!marker) return 89;
  fputs("executed", marker); fclose(marker);
  const char *value = getenv("KFW_VALUE"), *wrapper = getenv("KFW_WRAPPER_ONLY");
  printf("PID:%d\\nARG:%s\\nENV:%s\\nWRAPPER:%s\\nINPUT:", getpid(), argv[2], value ? value : "missing", wrapper ? wrapper : "missing");
  fflush(stdout);
  const char error[] = "TARGET_STDERR\\n";
  write(2, error, sizeof(error) - 1);
  char input[1024]; ssize_t length;
  while ((length = read(0, input, sizeof(input))) > 0) {
    ssize_t offset = 0;
    while (offset < length) {
      ssize_t written = write(1, input + offset, (size_t)(length - offset));
      if (written <= 0) return 91;
      offset += written;
    }
  }
  return atoi(argv[3]);
}
`,
    );
    await execute("/usr/bin/cc", [
      "-std=c11",
      "-O2",
      targetSource,
      "-o",
      target,
    ]);
  });

  afterEach(async () => {
    for (const entry of pending.splice(0)) {
      entry.channel.destroy();
      if (entry.child.exitCode === null && entry.child.signalCode === null)
        entry.child.kill("SIGKILL");
      await entry.exit;
    }
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  function launch(executable: string, args: string[], detached = true) {
    const child = spawn(binary, ["launch", executable, ...args], {
      detached,
      env: { PATH: "/usr/bin:/bin", KFW_WRAPPER_ONLY: "host-only" },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const channel = child.stdio[3];
    if (!(channel instanceof Duplex) || !child.stdout || !child.stderr)
      throw new Error("测试未获得原生私有双向通道与标准输出");
    let stdout = "",
      stderr = "",
      privateOutput = "";
    const messages: unknown[] = [];
    const exit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    pending.push({ channel, child, exit });
    child.stdout.setEncoding("utf8").on("data", (data) => {
      stdout += data;
    });
    child.stderr.setEncoding("utf8").on("data", (data) => {
      stderr += data;
    });
    // Invalid-frame cases may close the socket while the parent is ending it.
    channel.on("error", () => {});
    const hello = new Promise<PosixSessionIdentity>((resolve, reject) => {
      let settled = false;
      let buffered = "";
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("原生 HELLO 超时"));
        }
      }, 4000);
      channel.setEncoding("utf8").on("data", (data: string) => {
        privateOutput += data;
        buffered += data;
        for (;;) {
          const end = buffered.indexOf("\n");
          if (end < 0) break;
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          try {
            const message = JSON.parse(line);
            messages.push(message);
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(message);
            }
          } catch (error) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(error);
            }
          }
        }
      });
      child.once("close", () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error("原生 launcher 在 HELLO 前退出"));
        }
      });
    });
    return {
      child,
      channel,
      hello,
      exit,
      messages,
      stdout: () => stdout,
      stderr: () => stderr,
      privateOutput: () => privateOutput,
    };
  }

  test("未放行不执行；adopt 复验原 birth 后保留 argv、环境、标准流与退出码且不泄露 fd3", async () => {
    const marker = join(root, "released.marker");
    const argument = "空格 ' 引号 $() ; =";
    const value = "用户环境=中文\n第二行";
    const secret = "synthetic-target-env-only";
    const launched = launch(target, [marker, argument, "23"]);
    const identity = await launched.hello;
    expect(Object.keys(identity).sort()).toEqual([
      "sessionId",
      "startSec",
      "startUsec",
    ]);
    expect(identity.sessionId).toBe(launched.child.pid);
    await delay(40);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(launched.stdout()).toBe("");
    expect(launched.stderr()).toBe("");
    const wrapper = await execute("/bin/ps", [
      "eww",
      "-p",
      String(identity.sessionId),
      "-o",
      "command=",
    ]);
    expect(wrapper.stdout).toContain("KFW_WRAPPER_ONLY=host-only");
    expect(wrapper.stdout).not.toContain(secret);
    await expect(
      PtySessionRange.adopt(
        binary,
        { ...identity, startUsec: (identity.startUsec + 1) % 1_000_000 },
        limits,
      ),
    ).rejects.toMatchObject({ code: "stop_unconfirmed" });
    await PtySessionRange.adopt(binary, identity, limits);
    const frame = environmentFrame({ KFW_VALUE: value, KFW_SECRET: secret });
    launched.child.stdin?.end("输入\0原样\n");
    // A partial R frame must not apply the environment or start the target.
    launched.channel.write(frame.subarray(0, 7));
    await delay(30);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(launched.messages).toEqual([identity]);
    launched.channel.write(frame.subarray(7));
    expect(await launched.exit).toEqual({ code: 23, signal: null });
    expect(await readFile(marker, "utf8")).toBe("executed");
    expect(launched.stdout()).toBe(
      `PID:${identity.sessionId}\nARG:${argument}\nENV:${value}\nWRAPPER:missing\nINPUT:输入\0原样\n`,
    );
    expect(launched.stderr()).toBe("TARGET_STDERR\n");
    expect(launched.messages).toEqual([identity, { released: true }]);
    expect(launched.stdout()).not.toContain("sessionId");
    expect(launched.stderr()).not.toContain("sessionId");
  });

  test.each([
    ["EOF", Buffer.alloc(0)],
    ["错误标记", Buffer.from([0x58, 0, 0, 0, 0])],
    ["截断头", Buffer.from([0x52, 0, 0])],
    ["截断环境", Buffer.from([0x52, 0, 0, 0, 8, 0x41])],
    ["缺少末尾NUL", releaseFrame(Buffer.from("KEY=value"))],
    ["空变量名", releaseFrame(Buffer.from("=value\0"))],
    ["缺少等号", releaseFrame(Buffer.from("KEY\0"))],
    ["空条目", releaseFrame(Buffer.from("\0"))],
    ["非UTF8", releaseFrame(Buffer.from([0x41, 0x3d, 0xc0, 0xaf, 0]))],
    ["超过ARG_MAX", Buffer.from([0x52, 0xff, 0xff, 0xff, 0xff])],
  ])("%s 帧退出且绝不执行目标", async (_name, frame) => {
    const marker = join(root, "invalid-frame.marker");
    const launched = launch(target, [marker, "not-executed", "0"]);
    const identity = await launched.hello;
    await PtySessionRange.adopt(binary, identity, limits);
    launched.channel.end(frame);
    expect(await launched.exit).toEqual({ code: 2, signal: null });
    expect(launched.messages).toEqual([identity]);
    expect(launched.privateOutput()).not.toContain("released");
    expect(launched.stdout()).toBe("");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("已停止的原 leader 不能被 adopt 为可放行状态，停止仍复用原范围", async () => {
    const launched = launch("/usr/bin/true", []);
    const identity = await launched.hello;
    const range = await PtySessionRange.adopt(binary, identity, limits);
    await execute(binary, [
      "signal",
      String(identity.sessionId),
      String(identity.startSec),
      String(identity.startUsec),
      String(constants.signals.SIGSTOP),
    ]);
    await expect
      .poll(async () => {
        const result = await execute(binary, [
          "scan",
          String(identity.sessionId),
          String(identity.startSec),
          String(identity.startUsec),
        ]);
        const snapshot = JSON.parse(result.stdout);
        return snapshot.members.find(
          (member: { pid: number; state: string }) =>
            member.pid === identity.sessionId,
        )?.state;
      })
      .toBe("stopped");
    await expect(
      PtySessionRange.adopt(binary, identity, limits),
    ).rejects.toMatchObject({ code: "stop_unconfirmed" });
    await range.stop();
    expect((await launched.exit).signal).toBe("SIGTERM");
    expect(launched.messages).toEqual([identity]);
  });

  test("空目标环境可执行短命命令，原生身份总在 exec 前签发", async () => {
    for (let index = 0; index < 8; index++) {
      const launched = launch("/usr/bin/true", []);
      const identity = await launched.hello;
      await PtySessionRange.adopt(binary, identity, limits);
      launched.channel.write(environmentFrame({}));
      expect(await launched.exit).toEqual({ code: 0, signal: null });
      expect(launched.messages).toEqual([identity, { released: true }]);
      expect(launched.stdout()).toBe("");
      expect(launched.stderr()).toBe("");
    }
  });

  test("exec 失败通过私有通道返回真实 errno，不伪装为成功启动", async () => {
    const launched = launch(join(root, "missing-executable"), []);
    const identity = await launched.hello;
    await PtySessionRange.adopt(binary, identity, limits);
    launched.channel.write(environmentFrame({}));
    expect(await launched.exit).toEqual({ code: 127, signal: null });
    expect(launched.messages).toEqual([
      identity,
      { released: true },
      { exec_failed: 2 },
    ]);
    expect(launched.stdout()).toBe("");
    expect(launched.stderr()).toBe("");
  });

  test("非 detached leader 不签发身份或执行目标", async () => {
    const marker = join(root, "non-leader.marker");
    const launched = launch(target, [marker, "not-executed", "0"], false);
    await expect(launched.hello).rejects.toThrow("HELLO 前退出");
    expect(await launched.exit).toEqual({ code: 2, signal: null });
    expect(launched.messages).toEqual([]);
    expect(launched.stdout()).toBe("");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
