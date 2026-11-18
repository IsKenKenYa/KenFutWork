import {
  appendFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createProcessSandbox } from "./service.js";
import type { ProcessStdioSpawnRequest } from "./types.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function stdioRequest(root: string): ProcessStdioSpawnRequest {
  return {
    scope: {
      instanceId: "cancel-instance",
      projectId: "cancel-project",
      taskId: "cancel-task",
      generation: 1,
      rootDirectory: root,
      additionalDirectories: [],
      sandboxMode: "workspace-write",
    },
    agentId: "main",
    invocationId: "pending",
    argv: {
      executable: process.execPath,
      args: ["-e", "process.stdin.resume()"],
    },
    background: true,
    timeoutMs: null,
    limits: {
      maxOutputBytes: 65536,
      previewMaxChars: 8000,
      yieldMs: 10,
      killGraceMs: 2000,
    },
  };
}

async function fixture(
  mode:
    | "unlaunched"
    | "stopped"
    | "unconfirmed"
    | "missing-ack"
    | "wrong-invocation" = "unlaunched",
  initialization?: ReturnType<typeof gate>,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-spawn-cancel-")),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const journal = join(root, "messages.jsonl");
  const release = join(root, "release-cancel");
  const helper = join(root, "pending-helper.mjs");
  await writeFile(journal, "");
  await writeFile(
    helper,
    `import {appendFileSync,existsSync} from 'node:fs';
const journal=${JSON.stringify(journal)}, release=${JSON.stringify(release)}, mode=${JSON.stringify(mode)};
let spawning;
const snapshot=(request,stopped)=>({id:'synthetic-process',ownerTaskId:request.scope.taskId,agentId:request.agentId,invocationId:request.invocationId,generation:request.scope.generation,state:stopped?'stopped':'running',pid:null,startedAt:new Date().toISOString(),finishedAt:stopped?new Date().toISOString():null,enforcement:null,exit:stopped?{exitCode:null,signal:null,reason:'spawn_cancelled',stopped:true,rangeEmpty:mode!=='unconfirmed'}:null,retainedBytes:0,totalBytes:0,discardedBytes:0,outputPath:'unused'});
const send=(message,value)=>process.send({id:message.id,ok:true,value});
process.on('message',message=>{
 appendFileSync(journal,JSON.stringify(message)+'\\n');
 if(message.method==='initialize')send(message,null);
 if(message.method==='spawn'){
  spawning=message;
  if(message.request.invocationId==='instant')send(message,snapshot(message.request,false));
 }
 if(message.method==='cancelspawn'){
  const timer=setInterval(()=>{
   if(!existsSync(release))return;
   clearInterval(timer);
   if(mode==='missing-ack')return;
   const receipt=mode==='unlaunched'?null:snapshot(spawning.request,true);
   if(mode==='wrong-invocation')receipt.invocationId='other-invocation';
   send(message,receipt);
   if(spawning)process.send({id:spawning.id,ok:false,error:{code:'process_closed',message:'cancelled before spawn response'}});
  },5);
 }
 if(message.method==='close')process.send({id:message.id,ok:true,value:null},()=>process.disconnect());
});`,
  );
  let initializing = false;
  const sandbox = createProcessSandbox({
    captureRoot: join(root, "capture"),
    helperPath: helper,
    helperExecArgv: [],
    nodePath: process.execPath,
    network: { allowedDomains: [], deniedDomains: [] },
    resolveNetwork: async () => {
      initializing = true;
      await initialization?.promise;
      return { allowedDomains: [], deniedDomains: [] };
    },
  });
  cleanup.push(() => sandbox.close("fixture_cleanup"));
  const request = stdioRequest(root);
  return {
    root,
    sandbox,
    request,
    initializing: () => initializing,
    messages: async () =>
      (await readFile(journal, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    release: () => appendFile(release, "ready"),
  };
}

test("已取消的 stdio 请求不创建 helper 或派发命令", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const reason = new Error("cancel before admission");
  controller.abort(reason);
  const pending = f.sandbox.spawnStdio(
    { ...f.request, invocationId: "instant" },
    { signal: controller.signal },
  );
  await expect(pending).rejects.toBe(reason);
  expect(f.initializing()).toBe(false);
  expect(await f.messages()).toEqual([]);
});

test("共享初始化等待时取消立即结束本次准入，初始化完成后也不派发目标", async () => {
  const held = gate();
  const f = await fixture("unlaunched", held);
  const controller = new AbortController();
  const reason = new Error("cancel during initialization");
  const pending = f.sandbox.spawnStdio(f.request, {
    signal: controller.signal,
  });
  const result = pending.then(
    () => ({ unexpected: true }),
    (error: unknown) => ({ error }),
  );
  try {
    await expect.poll(f.initializing).toBe(true);
    controller.abort(reason);
    await expect(
      Promise.race([
        result,
        new Promise((resolve) =>
          setTimeout(() => resolve({ stuck: true }), 150),
        ),
      ]),
    ).resolves.toEqual({ error: reason });
  } finally {
    held.release();
  }
  expect(
    (await f.messages()).filter((message) => message.method === "spawn"),
  ).toEqual([]);
});

test.each(["unlaunched", "stopped"] as const)(
  "派发后取消等待 %s 回执，确认前不释放写域",
  async (mode) => {
    // 合成 helper 只验证父端 RPC/屏障；没有真实命令或 OS 范围，原生停止另行验收。
    const f = await fixture(mode);
    const controller = new AbortController();
    const reason = new Error("cancel after dispatch");
    let settled = false;
    const input = structuredClone(f.request);
    const pending = f.sandbox.spawnStdio(input, {
      signal: controller.signal,
    });
    const result = pending
      .then(
        () => ({ unexpected: true }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      await expect
        .poll(async () =>
          (await f.messages()).some((message) => message.method === "spawn"),
        )
        .toBe(true);
      input.scope.generation = 22;
      input.argv = { executable: "/mutated-after-dispatch", args: [] };
      controller.abort(reason);
      await expect
        .poll(async () =>
          (await f.messages()).some(
            (message) => message.method === "cancelspawn",
          ),
        )
        .toBe(true);
      expect(settled).toBe(false);
      const other = { ...f.request.scope, taskId: "restore-task" };
      await expect(
        f.sandbox.acquireRestoreBarrier(other, [f.root]),
      ).rejects.toMatchObject({ code: "restore_conflict" });
      await f.release();
      expect(await result).toEqual({ error: reason });
      const barrier = await f.sandbox.acquireRestoreBarrier(other, [f.root]);
      await barrier.release();
      const cancel = (await f.messages()).find(
        (message) => message.method === "cancelspawn",
      );
      expect(cancel).toMatchObject({
        taskId: f.request.scope.taskId,
        generation: 1,
        invocationId: "pending",
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      expect(JSON.stringify(await f.messages())).not.toContain('"signal"');
    } finally {
      await f.release();
      await result;
    }
  },
);

test.each(["unconfirmed", "missing-ack", "wrong-invocation"] as const)(
  "取消回执 %s 时保留 stop_unconfirmed 与恢复屏障",
  async (mode) => {
    const f = await fixture(mode);
    f.request.limits.killGraceMs = 100;
    const controller = new AbortController();
    const result = f.sandbox
      .spawnStdio(f.request, { signal: controller.signal })
      .then(
        () => ({ unexpected: true }),
        (error: unknown) => ({ error }),
      );
    try {
      await expect
        .poll(async () =>
          (await f.messages()).some((message) => message.method === "spawn"),
        )
        .toBe(true);
      controller.abort();
      await f.release();
      expect(await result).toMatchObject({
        error: { code: "stop_unconfirmed" },
      });
      await expect(
        f.sandbox.acquireRestoreBarrier(
          { ...f.request.scope, taskId: "restore-task" },
          [f.root],
        ),
      ).rejects.toMatchObject({ code: "restore_conflict" });
    } finally {
      await f.release();
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "真实 stdio 在 ready 事件与 spawn 返回之间取消，确认范围清空且新调用仍可运行",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "kfw-real-spawn-cancel-")),
    );
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const controller = new AbortController();
    const reason = new Error("cancel before public spawn returns");
    let pid: number | null = null;
    const sandbox = createProcessSandbox({
      captureRoot: join(root, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
      onSnapshot(snapshot) {
        if (
          snapshot.invocationId === "cancel-at-ready" &&
          snapshot.state === "running" &&
          !controller.signal.aborted
        ) {
          pid = snapshot.pid;
          controller.abort(reason);
        }
      },
    });
    cleanup.push(() => sandbox.close("real_spawn_cancel_cleanup"));
    const request = stdioRequest(root);
    request.scope.sandboxMode = "danger-full-access";
    request.invocationId = "cancel-at-ready";
    await expect(
      sandbox.spawnStdio(request, { signal: controller.signal }),
    ).rejects.toBe(reason);
    const ownPid = pid;
    if (ownPid === null) throw new Error("真实就绪事件未提供自有 PID");
    expect(() => process.kill(ownPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    const replay = await sandbox
      .spawnStdio(request, { signal: new AbortController().signal })
      .then(
        (child) => ({ snapshot: child.snapshot() }),
        (error: unknown) => ({ error }),
      );
    if ("snapshot" in replay)
      expect(replay.snapshot).toMatchObject({
        pid,
        exit: { rangeEmpty: true },
      });
    else expect(replay.error).toMatchObject({ code: "process_closed" });
    const next = await sandbox.spawnStdio({
      ...request,
      invocationId: "fresh-after-cancel",
      argv: {
        executable: process.execPath,
        args: ["-e", "process.stdout.write('RECOVER')"],
      },
    });
    const dispose = next.onStdout(() => {});
    const disposeError = next.onStderr(() => {});
    try {
      expect(await next.waitForExit()).toMatchObject({
        exitCode: 0,
        rangeEmpty: true,
      });
      expect((await next.readOutput({ offset: 0, maxBytes: 65536 })).data).toBe(
        "RECOVER",
      );
    } finally {
      dispose();
      disposeError();
    }
    const barrier = await sandbox.acquireRestoreBarrier(
      { ...request.scope, taskId: "restore-task" },
      [root],
    );
    await barrier.release();
  },
);
