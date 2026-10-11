import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { afterEach, expect, test } from "vitest";
import { createProcessSandbox } from "./service.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "公共 PTY 执行保持真实 TTY、创建尺寸与交互输入，停止确认 Task 进程范围为空",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-pty-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sandbox = createProcessSandbox({
      captureRoot: join(root, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
    });
    cleanups.push(() => sandbox.close("test_cleanup"));
    const scope: CodeExecutionScope = {
      instanceId: "pty-workspace",
      projectId: "pty-project",
      taskId: "pty-task",
      generation: 1,
      rootDirectory: root,
      additionalDirectories: [],
      sandboxMode: "read-only",
    };
    const child = await sandbox.spawnPty({
      scope,
      agentId: "human-terminal",
      invocationId: "pty-tracer",
      argv: {
        executable: "/bin/sh",
        args: [
          "-c",
          'test -t 0 && test -t 1 && printf "TTY_READY\\n"; stty size; read value; printf "INPUT:%s\\n" "$value"; sleep 100',
        ],
      },
      pty: { cols: 91, rows: 29 },
      background: true,
      timeoutMs: null,
      limits: {
        maxOutputBytes: 65536,
        previewMaxChars: 8000,
        yieldMs: 50,
        killGraceMs: 2000,
      },
    });
    await expect
      .poll(
        async () =>
          (await child.readOutput({ offset: 0, maxBytes: 1024 })).data,
      )
      .toContain("TTY_READY");
    // `stty size` 的输出是**下一帧**才到的：CI 冷容器里读一次只有 TTY_READY，
    // 断言就假红（实测 expected 'TTY_READY\r\n' to contain '29 91'）。等真实结果到齐，
    // 不猜它跟第一行同一帧。
    await expect
      .poll(
        async () =>
          (await child.readOutput({ offset: 0, maxBytes: 1024 })).data,
      )
      .toContain("29 91");
    await child.writeStdin("hello\r");
    await expect
      .poll(
        async () =>
          (await child.readOutput({ offset: 0, maxBytes: 1024 })).data,
      )
      .toContain("INPUT:hello");
    expect(child.snapshot().ownerTaskId).toBe(scope.taskId);
    const exit = await child.stop("terminal_disposed");
    expect(exit).toMatchObject({
      stopped: true,
      rangeEmpty: true,
      reason: "terminal_disposed",
    });
    expect(await child.waitForExit()).toEqual(exit);
    await expect(child.writeStdin("late\r")).rejects.toMatchObject({
      code: "process_closed",
    });
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "公共 PTY resize 更新真实终端尺寸且方向键与 Ctrl+C 原样到达 raw 程序",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "kfw-pty-resize-")),
    );
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sandbox = createProcessSandbox({
      captureRoot: join(root, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
    });
    cleanups.push(() => sandbox.close("test_cleanup"));
    const child = await sandbox.spawnPty({
      scope: {
        instanceId: "workspace",
        projectId: "project",
        taskId: "resize-task",
        generation: 1,
        rootDirectory: root,
        additionalDirectories: [],
        sandboxMode: "read-only",
      },
      agentId: "human-terminal",
      invocationId: "resize-tracer",
      argv: {
        executable: process.execPath,
        args: [
          "-e",
          'process.stdin.setRawMode(true);process.stdin.on("data",b=>process.stdout.write("KEY:"+b.toString("hex")+"\\n"));process.stdout.on("resize",()=>process.stdout.write("SIZE:"+process.stdout.rows+"x"+process.stdout.columns+"\\n"));process.stdout.write("RAW_READY\\n")',
        ],
      },
      pty: { cols: 80, rows: 24 },
      background: true,
      timeoutMs: null,
      limits: {
        maxOutputBytes: 65536,
        previewMaxChars: 8000,
        yieldMs: 50,
        killGraceMs: 2000,
      },
    });
    const output = async () =>
      (await child.readOutput({ offset: 0, maxBytes: 4096 })).data;
    await expect.poll(output).toContain("RAW_READY");
    await child.resize(113, 37);
    await expect.poll(output).toContain("SIZE:37x113");
    await child.writeStdin("\u001b[A\u0003");
    await expect.poll(output).toContain("KEY:1b5b4103");
    expect((await child.stop("terminal_disposed")).rangeEmpty).toBe(true);
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "PTY 实时 ANSI 输出越过历史 capture 上限仍持续显示",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-pty-live-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sandbox = createProcessSandbox({
      captureRoot: join(root, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
    });
    cleanups.push(() => sandbox.close("test_cleanup"));
    const child = await sandbox.spawnPty({
      scope: {
        instanceId: "workspace",
        projectId: "project",
        taskId: "live-task",
        generation: 1,
        rootDirectory: root,
        additionalDirectories: [],
        sandboxMode: "read-only",
      },
      agentId: "human-terminal",
      invocationId: "live-tracer",
      argv: {
        executable: process.execPath,
        args: [
          "-e",
          'process.stdin.setRawMode(true);process.stdin.on("data",()=>{process.stdout.write("X".repeat(1024));process.stdout.write("\\x1b[31mLIVE_END\\x1b[0m\\n")});process.stdout.write("LIVE_READY\\n")',
        ],
      },
      pty: { cols: 80, rows: 24 },
      background: true,
      timeoutMs: null,
      limits: {
        maxOutputBytes: 128,
        previewMaxChars: 8000,
        yieldMs: 50,
        killGraceMs: 2000,
      },
    });
    await expect
      .poll(
        async () => (await child.readOutput({ offset: 0, maxBytes: 128 })).data,
      )
      .toContain("LIVE_READY");
    let live = "";
    const dispose = child.onOutput((data) => {
      live += data;
    });
    await child.writeStdin("go");
    await expect.poll(() => live).toContain("\u001b[31mLIVE_END\u001b[0m");
    const capture = await child.readOutput({ offset: 0, maxBytes: 128 });
    expect(capture.retainedBytes).toBe(128);
    expect(capture.truncated).toBe(true);
    expect(capture.data).not.toContain("LIVE_END");
    dispose();
    expect((await child.stop("terminal_disposed")).rangeEmpty).toBe(true);
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "PTY live 游标按真实 UTF8 字节连续递增，初始帧在订阅前保留且不因 capture 截断重置",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "kfw-pty-cursor-")),
    );
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sandbox = createProcessSandbox({
      captureRoot: join(root, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
    });
    cleanups.push(() => sandbox.close("test_cleanup"));
    const child = await sandbox.spawnPty({
      scope: {
        instanceId: "workspace",
        projectId: "project",
        taskId: "cursor-task",
        generation: 1,
        rootDirectory: root,
        additionalDirectories: [],
        sandboxMode: "read-only",
      },
      agentId: "human-terminal",
      invocationId: "cursor-tracer",
      argv: {
        executable: process.execPath,
        args: [
          "-e",
          'process.stdin.setRawMode(true);process.stdin.on("data",()=>process.stdout.write("\\x1b[32m末尾\\x1b[0m"));process.stdout.write("中A")',
        ],
      },
      pty: { cols: 80, rows: 24 },
      background: true,
      timeoutMs: null,
      limits: {
        maxOutputBytes: 4,
        previewMaxChars: 8000,
        yieldMs: 50,
        killGraceMs: 2000,
      },
    });
    const frames: Array<{
      sequence: number;
      offset: number;
      nextOffset: number;
      data: string;
    }> = [];
    const dispose = child.onOutput((data, cursor) => {
      frames.push({ ...cursor, data });
    });
    await expect
      .poll(() => frames.map((frame) => frame.data).join(""))
      .toBe("中A");
    expect(frames[0]?.offset).toBe(0);
    expect(frames.at(-1)?.nextOffset).toBe(4);
    await child.writeStdin("go");
    await expect
      .poll(() => frames.map((frame) => frame.data).join(""))
      .toBe("中A\u001b[32m末尾\u001b[0m");
    expect(frames.at(-1)?.nextOffset).toBe(19);
    for (let index = 0; index < frames.length; index++) {
      expect(frames[index]?.sequence).toBe(index + 1);
      expect(frames[index]?.offset).toBe(
        index === 0 ? 0 : frames[index - 1]?.nextOffset,
      );
    }
    expect(
      (await child.readOutput({ offset: 0, maxBytes: 4 })).retainedBytes,
    ).toBe(4);
    dispose();
    expect((await child.stop("terminal_disposed")).rangeEmpty).toBe(true);
  },
);

test
  .skipIf(!["darwin", "linux"].includes(process.platform))
  .each(["stop", "exit", "revoke"])(
  "PTY %s 确认涵盖 shell job-control 的后台进程组，不把 shell 退出当范围为空",
  async (action) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-pty-jobs-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const marker = join(root, "heartbeat.json");
    const program = join(root, "background-job.js");
    await writeFile(
      program,
      `const fs=require("node:fs");process.on("SIGHUP",()=>{});process.on("SIGTERM",()=>{});const procStat=process.platform==="linux"?fs.readFileSync("/proc/self/stat","utf8"):null;const stat=procStat?procStat.split(") ")[1].split(" "):null;let count=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,procPid:procStat?Number(procStat.split(" ")[0]):null,groupId:stat?Number(stat[2]):null,count:++count})),20);process.stdout.write("JOB_READY\\n")`,
    );
    const sandbox = createProcessSandbox({
      captureRoot: join(root, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
    });
    cleanups.push(() => sandbox.close("test_cleanup"));
    const child = await sandbox.spawnPty({
      scope: {
        instanceId: "workspace",
        projectId: "project",
        taskId: "jobs-task",
        generation: 1,
        rootDirectory: root,
        additionalDirectories: [],
        sandboxMode: "workspace-write",
      },
      agentId: "human-terminal",
      invocationId: "jobs-tracer",
      argv: { executable: "/bin/bash", args: ["--noprofile", "--norc", "-i"] },
      pty: { cols: 80, rows: 24 },
      background: true,
      timeoutMs: null,
      limits: {
        maxOutputBytes: 65536,
        previewMaxChars: 8000,
        yieldMs: 50,
        killGraceMs: 2000,
      },
    });
    await child.writeStdin(
      `${JSON.stringify(process.execPath)} ${JSON.stringify(program)} &\r`,
    );
    await expect
      .poll(async () => {
        await child.readOutput({ offset: 0, maxBytes: 4096 });
        try {
          return JSON.parse(await readFile(marker, "utf8")) as {
            pid: number;
            count: number;
          };
        } catch {
          return null;
        }
      })
      .not.toBeNull();
    const job = JSON.parse(await readFile(marker, "utf8")) as {
      pid: number;
      groupId: number | null;
      procPid: number | null;
      count: number;
    };
    if (process.platform === "linux") expect(job.groupId).toBe(job.procPid);
    cleanups.push(async () => {
      // Linux job.pid 是沙箱 PID namespace 的局部身份，绝不向同号宿主 PID 发信号。
      if (process.platform !== "darwin") return;
      try {
        process.kill(job.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    });
    if (action === "exit") {
      // 真实GUI先激活reader再输入；此例锁进程组清空，不引入无人消费输出的readline回压。
      const dispose = child.onOutput(() => {});
      cleanups.push(async () => dispose());
      await child.writeStdin("exit\r");
    }
    if (action === "revoke")
      await sandbox.revokeTask("jobs-task", 2, "permissions_changed");
    const exit =
      action === "stop"
        ? await child.stop("terminal_disposed")
        : await child.waitForExit();
    expect(exit.rangeEmpty).toBe(true);
    if (action === "revoke")
      await expect(child.writeStdin("late\r")).rejects.toMatchObject({
        code: "scope_revoked",
      });
    const stopped = await readFile(marker, "utf8");
    await delay(150);
    expect(await readFile(marker, "utf8")).toBe(stopped);
  },
  15_000,
);

test.skipIf(!["darwin", "linux"].includes(process.platform)).each([0, 50])(
  "快速退出的 PTY 等待异步 reader 读尽最后输出才发布 exit，不被 native close 截掉尾部（尾部延迟 %i ms）",
  async (tailDelay) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "kfw-pty-drain-")),
    );
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sandbox = createProcessSandbox({
      captureRoot: join(root, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
    });
    cleanups.push(() => sandbox.close("test_cleanup"));
    const child = await sandbox.spawnPty({
      scope: {
        instanceId: "workspace",
        projectId: "project",
        taskId: "drain-task",
        generation: 1,
        rootDirectory: root,
        additionalDirectories: [],
        sandboxMode: "read-only",
      },
      agentId: "human-terminal",
      invocationId: "drain-tracer",
      argv: {
        executable: process.execPath,
        args: [
          "-e",
          tailDelay === 0
            ? 'process.stdin.setRawMode(true);process.stdout.write("DRAIN_READY\\n");process.stdin.once("data",()=>{process.stdout.write("Y".repeat(1000)+"TAIL_END\\n");process.exit(0)})'
            : 'process.stdin.setRawMode(true);process.stdout.write("DRAIN_READY\\n");process.stdin.once("data",()=>{process.stdout.write("Y".repeat(1000));setTimeout(()=>{process.stdout.write("TAIL_END\\n");process.exit(0)},50)})',
        ],
      },
      pty: { cols: 80, rows: 24 },
      background: true,
      timeoutMs: null,
      limits: {
        maxOutputBytes: 65536,
        previewMaxChars: 8000,
        yieldMs: 50,
        killGraceMs: 2000,
      },
    });
    await expect
      .poll(
        async () => (await child.readOutput({ offset: 0, maxBytes: 128 })).data,
      )
      .toContain("DRAIN_READY");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstDelivery = new Promise<void>((resolve) => {
      entered = resolve;
    });
    cleanups.push(async () => {
      release();
    });
    let live = "";
    const dispose = child.onOutput(async (data) => {
      live += data;
      if (data.includes("Y")) {
        entered();
        await gate;
      }
    });
    cleanups.push(async () => {
      dispose();
    });
    await child.writeStdin("go");
    await firstDelivery;
    let exited = false;
    const exit = child.waitForExit().then((result) => {
      exited = true;
      return result;
    });
    await delay(350);
    expect(exited).toBe(false);
    release();
    expect(await exit).toMatchObject({
      exitCode: 0,
      stopped: false,
      rangeEmpty: true,
    });
    expect(live.endsWith("TAIL_END\r\n")).toBe(true);
    expect(Buffer.byteLength(live)).toBe(1010);
    const captured = await child.readOutput({ offset: 0, maxBytes: 65536 });
    expect(captured.done).toBe(true);
    expect(captured.data).toContain("TAIL_END");
  },
  15_000,
);
