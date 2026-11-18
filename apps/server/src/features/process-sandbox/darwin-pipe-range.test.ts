import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { executionEnvironment } from "./environment.js";
import { ProcessOutputCapture } from "./output-capture.js";
import { preparePtySessionInspector } from "./pty-native-runtime.js";
import { PtySessionRange } from "./pty-session-range.js";
import type { ManagedProcessSnapshot, ProcessSpawnRequest } from "./types.js";
import { UnixManagedProcess } from "./unix-process.js";

const limits = {
  maxOutputBytes: 65536,
  previewMaxChars: 8000,
  yieldMs: 10,
  killGraceMs: 2000,
};
let root: string;
let inspector: string;
let serial = 0;
const cleanups: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
  if (process.platform !== "darwin") return;
  root = await realpath(await mkdtemp(join(tmpdir(), "kfw-pipe-birth-")));
  inspector = await preparePtySessionInspector(root, limits);
});
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}
function fixture(
  program: string,
  startupSignal?: AbortSignal,
  executable = process.execPath,
) {
  const id = `pipe-${++serial}`;
  const capture = new ProcessOutputCapture(
    join(root, `${id}.bin`),
    limits.maxOutputBytes,
  );
  const request: ProcessSpawnRequest = {
    scope: {
      instanceId: "pipe-instance",
      projectId: "pipe-project",
      taskId: "pipe-task",
      generation: 1,
      rootDirectory: root,
      additionalDirectories: [],
      sandboxMode: "danger-full-access",
    },
    agentId: "main",
    invocationId: id,
    background: true,
    timeoutMs: null,
    limits,
    argv: { executable, args: ["-e", program] },
  };
  const initial: ManagedProcessSnapshot = {
    id,
    ownerTaskId: request.scope.taskId,
    agentId: request.agentId,
    invocationId: id,
    generation: 1,
    state: "starting",
    pid: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exit: null,
    retainedBytes: 0,
    totalBytes: 0,
    discardedBytes: 0,
    outputPath: capture.path,
    enforcement: {
      backend: "host-account",
      filesystem: "unrestricted",
      processRange: "process-group",
      permissionsGeneration: 1,
    },
  };
  const owner = new UnixManagedProcess(
    {
      argv: [executable, "-e", program],
      env: executionEnvironment(process.env),
    },
    request,
    root,
    capture,
    initial,
    () => {},
    () => {},
    undefined,
    undefined,
    inspector,
    undefined,
    startupSignal ? { signal: startupSignal } : {},
  );
  cleanups.push(async () => {
    if (!owner.snapshot().exit?.rangeEmpty) await owner.stop("fixture_cleanup");
  });
  return owner;
}

test.skipIf(process.platform !== "darwin")(
  "pipes 在原生出生身份签发之前不执行目标，取得范围后才放行",
  async () => {
    const held = gate();
    const original = PtySessionRange.adopt;
    let validating = false;
    vi.spyOn(PtySessionRange, "adopt").mockImplementation(async (...args) => {
      validating = true;
      await held.promise;
      return original(...args);
    });
    const marker = join(root, "before-birth.txt");
    const owner = fixture(
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');process.stdin.resume()`,
    );
    try {
      await expect
        .poll(async () => validating || (await exists(marker)))
        .toBe(true);
      expect(await exists(marker), "目标先于范围签发执行").toBe(false);
      held.release();
      await owner.ready.promise;
      await expect.poll(() => exists(marker)).toBe(true);
      expect((await owner.stop("verified_stop")).rangeEmpty).toBe(true);
    } finally {
      held.release();
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "exec 失败保留 spawn_failed，确认清空后仍可关闭 owner",
  async () => {
    const owner = fixture("", undefined, join(root, "missing-executable"));
    await expect(owner.ready.promise).rejects.toMatchObject({
      code: "spawn_failed",
      message: expect.stringContaining("ENOENT"),
    });
    await expect(owner.wait()).rejects.toMatchObject({ code: "spawn_failed" });
    expect((await owner.stop("after_spawn_failure")).rangeEmpty).toBe(true);
    expect(owner.snapshot()).toMatchObject({
      state: "failed",
      exit: { exitCode: 127, rangeEmpty: true },
    });
    expect(owner.output(0, 65536).data).toBe("");
  },
);

test.skipIf(process.platform !== "darwin")(
  "停止自己的父子进程范围不影响另一个独立会话",
  async () => {
    const other = fixture(
      "process.stdout.write('READY');process.stdin.on('data',()=>process.stdout.write('PONG'))",
    );
    await other.ready.promise;
    const owner = fixture(
      `const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e',"process.stdout.write('CHILD:'+process.pid+'\\\\n');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']}); child.stdout.pipe(process.stdout);process.stdout.write('PARENT:'+process.pid+'\\n');process.stdin.resume();`,
    );
    await owner.ready.promise;
    await expect.poll(() => owner.output(0, 65536).data).toContain("CHILD:");
    const pids = [
      ...owner.output(0, 65536).data.matchAll(/(?:PARENT|CHILD):(\d+)/gu),
    ].map((match) => Number(match[1]));
    expect(pids).toHaveLength(2);
    expect(await owner.stop("stop_own_tree")).toMatchObject({
      rangeEmpty: true,
      stopped: true,
    });
    await other.stdin("ping");
    await expect.poll(() => other.output(0, 65536).data).toContain("PONG");
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "签发期间撤权不放行目标，EOF 收尾不借数值 PGID 发送信号",
  async () => {
    const held = gate();
    const original = PtySessionRange.adopt;
    let validating = false;
    vi.spyOn(PtySessionRange, "adopt").mockImplementation(async (...args) => {
      validating = true;
      await held.promise;
      return original(...args);
    });
    const kill = vi.spyOn(process, "kill");
    const controller = new AbortController();
    const marker = join(root, "cancelled-launch.txt");
    const owner = fixture(
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad');process.stdin.resume()`,
      controller.signal,
    );
    try {
      await expect.poll(() => validating).toBe(true);
      controller.abort(new Error("Task revoked before release"));
      const stopping = owner.stop("task_revoked");
      void stopping.catch(() => {});
      held.release();
      await expect(owner.ready.promise).rejects.toThrow();
      expect(await stopping).toMatchObject({
        rangeEmpty: true,
        stopped: true,
        reason: "task_revoked",
      });
      expect(await exists(marker)).toBe(false);
      expect(kill.mock.calls.filter(([pid]) => pid < 0)).toEqual([]);
    } finally {
      held.release();
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "短命 pipes 仍交付末尾输出与退出，私有握手不混入 capture",
  async () => {
    for (let iteration = 0; iteration < 5; iteration++) {
      const owner = fixture(
        "process.stdout.write('尾帧');process.stderr.write('诊断');",
      );
      await owner.ready.promise;
      expect(await owner.wait()).toMatchObject({
        exitCode: 0,
        signal: null,
        rangeEmpty: true,
      });
      expect(owner.output(0, 65536, "stdout").data).toBe("尾帧");
      expect(owner.output(0, 65536, "stderr").data).toBe("诊断");
    }
  },
);
