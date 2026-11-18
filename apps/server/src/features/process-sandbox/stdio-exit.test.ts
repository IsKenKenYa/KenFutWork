import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createProcessSandbox } from "./service.js";
import type { ManagedStdioProcess, ProcessExit } from "./types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ownProcessGone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}

test.skipIf(process.platform !== "darwin").each(["stdout", "stderr"] as const)(
  "正常child退出时%s首帧ACK仍挂起，释放后完整交付AB且范围确认退出",
  async (heldStream) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "kfw-stdio-exit-")),
    );
    const sandbox = createProcessSandbox({
      captureRoot: join(root, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
    });
    const firstFrame = deferred<void>();
    const releaseAck = deferred<void>();
    const reportedPid = deferred<number>();
    const otherStream = heldStream === "stdout" ? "stderr" : "stdout";
    const program = `const held=process.${heldStream};
const control=process.${otherStream};
held.write("A",()=>{
  control.write("PID:"+process.pid+"\\n");
  process.stdin.once("data",()=>held.write("B",()=>process.exit(0)));
});`;
    let child: ManagedStdioProcess | undefined;
    let completion:
      | Promise<{ exit: ProcessExit } | { error: unknown }>
      | undefined;
    const disposers: Array<() => void> = [];
    const failures: unknown[] = [];
    let output = "";
    let control = "";
    let heldFirstFrame = false;
    const consumeHeld = async (data: string) => {
      output += data;
      if (!heldFirstFrame) {
        heldFirstFrame = true;
        firstFrame.resolve();
        await releaseAck.promise;
      }
    };
    const consumeControl = (data: string) => {
      control += data;
      const match = /^PID:(\d+)\n/u.exec(control);
      if (match) reportedPid.resolve(Number(match[1]));
    };
    try {
      child = await sandbox.spawnStdio({
        scope: {
          instanceId: "stdio-exit-instance",
          projectId: "stdio-exit-project",
          taskId: "stdio-exit-task",
          generation: 1,
          rootDirectory: root,
          additionalDirectories: [],
          sandboxMode: "read-only",
        },
        agentId: "main",
        invocationId: `held-${heldStream}`,
        argv: { executable: process.execPath, args: ["-e", program] },
        background: true,
        timeoutMs: 10_000,
        limits: {
          maxOutputBytes: 65536,
          previewMaxChars: 8000,
          yieldMs: 20,
          killGraceMs: 2000,
        },
      });
      disposers.push(
        child.onStdout(heldStream === "stdout" ? consumeHeld : consumeControl),
        child.onStderr(heldStream === "stderr" ? consumeHeld : consumeControl),
      );
      completion = child.waitForExit().then(
        (exit) => ({ exit }),
        (error: unknown) => ({ error }),
      );
      await firstFrame.promise;
      const pid = await reportedPid.promise;
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(output).toBe("A");
      await child.writeStdin("exit-after-B\n");
      // 这里只观察本测试子进程的真实PID；不把此观察替代下面的rangeEmpty协议断言。
      await expect
        .poll(() => ownProcessGone(pid), { timeout: 5000 })
        .toBe(true);
      releaseAck.resolve();
      const result = await completion;
      expect(result).toMatchObject({
        exit: { exitCode: 0, signal: null, stopped: false, rangeEmpty: true },
      });
      expect(output).toBe("AB");
      expect(control).toBe(`PID:${pid}\n`);
      expect(
        (
          await child.readOutput({
            offset: 0,
            maxBytes: 65536,
            stream: heldStream,
          })
        ).data,
      ).toBe("AB");
    } catch (error) {
      failures.push(error);
    } finally {
      // RED时也先释放consumer，避免测试自己的ACK barrier阻塞资源清理。
      releaseAck.resolve();
      if (child) {
        try {
          const exit = await child.stop("stdio_exit_fixture_cleanup");
          expect(exit.rangeEmpty).toBe(true);
        } catch (error) {
          failures.push(error);
        }
      }
      if (completion) await completion;
      for (const dispose of disposers.reverse()) dispose();
      try {
        await sandbox.close("stdio_exit_fixture_cleanup");
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 0)
        await rm(root, { recursive: true, force: true });
      else console.error(`stdio退出回归诊断目录：${root}`);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "stdio退出断言与进程清理尚未全部完成");
  },
  30_000,
);
