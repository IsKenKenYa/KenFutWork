import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { afterEach, expect, test } from "vitest";
import { readCapturedOutput } from "./output-capture.js";
import { createProcessSandbox } from "./service.js";
import type { ProcessSandbox, ProcessSpawnRequest } from "./types.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("shell 不能绕过附加目录的只读授权，扩权保留后台进程而收紧确认终止", async () => {
  const fixture = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-process-scope-")),
  );
  cleanups.push(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "project");
  const reference = join(fixture, "reference");
  await mkdir(root);
  await mkdir(reference);
  const readonlyFile = join(reference, "source.txt");
  await writeFile(readonlyFile, "reference source");
  const sandbox = createProcessSandbox({
    captureRoot: join(fixture, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  cleanups.push(() => sandbox.close("test_cleanup"));
  const scope: CodeExecutionScope = {
    instanceId: "workspace",
    projectId: "project",
    taskId: "scope-task",
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [{ path: reference, access: "read-only" }],
    sandboxMode: "workspace-write",
  };
  const program = `const fs=require("node:fs");process.stdout.write(fs.readFileSync(${JSON.stringify(readonlyFile)},"utf8")+"\\n");try{fs.writeFileSync(${JSON.stringify(readonlyFile)},"corruption");process.exit(9)}catch(e){process.stdout.write("write-blocked\\n")}process.stdin.on("data",b=>process.stdout.write(b))`;
  const encoded = Buffer.from(program).toString("base64");
  const child = await sandbox.spawn({
    scope,
    agentId: "worker",
    invocationId: "readonly-proof",
    command: `${JSON.stringify(process.execPath)} -e "eval(Buffer.from('${encoded}','base64').toString())"`,
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
      async () => (await child.readOutput({ offset: 0, maxBytes: 1024 })).data,
    )
    .toContain("write-blocked\n");
  expect(await readFile(readonlyFile, "utf8")).toBe("reference source");
  const expanded: CodeExecutionScope = {
    ...scope,
    generation: 2,
    additionalDirectories: [{ path: reference, access: "read-write" }],
  };
  await sandbox.applyScopeChange(scope, expanded, "scope_expanded");
  await child.writeStdin("still-running\n");
  await expect
    .poll(
      async () => (await child.readOutput({ offset: 0, maxBytes: 1024 })).data,
    )
    .toContain("still-running\n");
  expect(child.snapshot().enforcement?.permissionsGeneration).toBe(1);
  const tightened: CodeExecutionScope = {
    ...expanded,
    generation: 3,
    sandboxMode: "read-only",
  };
  await sandbox.applyScopeChange(expanded, tightened, "scope_tightened");
  const exit = await child.waitForExit();
  expect(exit).toMatchObject({
    stopped: true,
    rangeEmpty: true,
    reason: "scope_tightened",
  });
  await expect(child.writeStdin("late\n")).rejects.toMatchObject({
    code: "scope_revoked",
  });
});

test("真实命令的输出可继续读取，停止确认退出后不再接受 stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "kfw-managed-process-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sandbox: ProcessSandbox = createProcessSandbox({
    captureRoot: join(root, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  cleanups.push(() => sandbox.close("test_cleanup"));
  const scope: CodeExecutionScope = {
    instanceId: "test-workspace",
    projectId: "test-project",
    taskId: "test-task",
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "read-only",
  };
  const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write("proof\\n");setInterval(()=>{},1000)'`;
  const child = await sandbox.spawn({
    scope,
    agentId: "main",
    invocationId: "proof-call",
    command,
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
      async () => (await child.readOutput({ offset: 0, maxBytes: 1024 })).data,
    )
    .toContain("proof\n");
  const first = await child.readOutput({ offset: 0, maxBytes: 1024 });
  const continued = await child.readOutput({
    offset: first.nextOffset,
    maxBytes: 1024,
  });
  expect(continued.data).toBe("");
  expect(child.snapshot().ownerTaskId).toBe(scope.taskId);
  const stopped = await child.stop("user_stop");
  expect(stopped.rangeEmpty).toBe(true);
  expect(stopped.stopped).toBe(true);
  await expect(child.writeStdin("late input")).rejects.toMatchObject({
    code: "process_closed",
  });
  expect(await child.waitForExit()).toEqual(stopped);
});

test("精确 argv 和显式环境保持字面量，stdin EOF 让真实消费者退出", async () => {
  const fixture = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-process-argv-")),
  );
  cleanups.push(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "project");
  await mkdir(root);
  const marker = join(root, "shell-expansion-marker");
  const literal = `$(touch '${marker}'); \`printf injected\` 'quoted' "double" 中文`;
  const environment = "$HOME `printf env-injected` 'literal'";
  const sandbox = createProcessSandbox({
    captureRoot: join(fixture, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  cleanups.push(() => sandbox.close("test_cleanup"));
  const scope: CodeExecutionScope = {
    instanceId: "workspace",
    projectId: "project",
    taskId: "argv-task",
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  const program =
    'const chunks=[];process.stdin.on("data",b=>chunks.push(b));process.stdin.on("end",()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(1),input:Buffer.concat(chunks).toString("utf8"),env:process.env.KFW_TEST_VALUE})))';
  const child = await sandbox.spawn({
    scope,
    agentId: "worker",
    invocationId: "argv-eof-proof",
    argv: { executable: process.execPath, args: ["-e", program, literal] },
    env: { KFW_TEST_VALUE: environment },
    background: false,
    timeoutMs: null,
    limits: {
      maxOutputBytes: 65536,
      previewMaxChars: 8000,
      yieldMs: 50,
      killGraceMs: 2000,
    },
  });
  await child.writeStdin("真实输入：你好\n");
  await child.endStdin();
  const exit = await child.waitForExit();
  expect(exit).toMatchObject({ exitCode: 0, stopped: false, rangeEmpty: true });
  const output = await child.readOutput({ offset: 0, maxBytes: 4096 });
  expect(JSON.parse(output.data)).toEqual({
    argv: [literal],
    input: "真实输入：你好\n",
    env: environment,
  });
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("真实 UTF-8 输出分片未完成时不损坏字符，继续游标按字节推进", async () => {
  const fixture = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-process-utf8-")),
  );
  cleanups.push(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "project");
  await mkdir(root);
  const sandbox = createProcessSandbox({
    captureRoot: join(fixture, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  cleanups.push(() => sandbox.close("test_cleanup"));
  const scope: CodeExecutionScope = {
    instanceId: "workspace",
    projectId: "project",
    taskId: "utf8-task",
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "read-only",
  };
  const program =
    'const text=Buffer.from("你🙂x");process.stdout.write(text.subarray(0,1));process.stdin.once("data",()=>{process.stdout.write(text.subarray(1));process.stdin.destroy()})';
  const child = await sandbox.spawn({
    scope,
    agentId: "explore",
    invocationId: "utf8-proof",
    argv: { executable: process.execPath, args: ["-e", program] },
    background: true,
    timeoutMs: null,
    limits: {
      maxOutputBytes: 32,
      previewMaxChars: 16,
      yieldMs: 50,
      killGraceMs: 2000,
    },
  });
  await expect.poll(() => child.snapshot().retainedBytes).toBe(1);
  expect(await child.readOutput({ offset: 0, maxBytes: 1 })).toMatchObject({
    data: "",
    nextOffset: 0,
    done: false,
  });
  await child.writeStdin("continue");
  await child.waitForExit();
  const first = await child.readOutput({ offset: 0, maxBytes: 1 });
  expect(first).toMatchObject({ data: "你", nextOffset: 3 });
  const second = await child.readOutput({
    offset: first.nextOffset,
    maxBytes: 1,
  });
  expect(second).toMatchObject({ data: "🙂", nextOffset: 7 });
  const last = await child.readOutput({
    offset: second.nextOffset,
    maxBytes: 1,
  });
  expect(last).toMatchObject({ data: "x", nextOffset: 8, done: true });
});

async function processFixture(taskId: string) {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "kfw-process-")));
  cleanups.push(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "project");
  await mkdir(root);
  const sandbox = createProcessSandbox({
    captureRoot: join(fixture, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  cleanups.push(() => sandbox.close("test_cleanup"));
  const scope: CodeExecutionScope = {
    instanceId: "workspace",
    projectId: "project",
    taskId,
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  const request = (program: string): ProcessSpawnRequest => ({
    scope,
    agentId: "worker",
    invocationId: `${taskId}-call`,
    argv: { executable: process.execPath, args: ["-e", program] },
    background: true,
    timeoutMs: null,
    limits: {
      maxOutputBytes: 65536,
      previewMaxChars: 8000,
      yieldMs: 20,
      killGraceMs: 2000,
    },
  });
  return { fixture, root, sandbox, scope, request };
}

test("同一调用并发及响应丢失后的重放只执行一次，参数冲突不启动新进程", async () => {
  const { root, sandbox, request } = await processFixture("replay-task");
  const marker = join(root, "execution-count.txt");
  const input = request(
    `require("node:fs").appendFileSync(${JSON.stringify(marker)},"x");process.stdout.write("executed")`,
  );
  const [first, concurrent] = await Promise.all([
    sandbox.spawn(input),
    sandbox.spawn(input),
  ]);
  await Promise.all([first.waitForExit(), concurrent.waitForExit()]);
  expect(concurrent.id).toBe(first.id);
  expect(await readFile(marker, "utf8")).toBe("x");
  const replay = await sandbox.spawn(input);
  expect(replay.id).toBe(first.id);
  expect(await readFile(marker, "utf8")).toBe("x");
  await expect(
    sandbox.spawn({
      ...input,
      argv: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
    }),
  ).rejects.toMatchObject({ code: "invalid_process_request" });
});

test.each([1, 2, 3, 4, 5])(
  "交叠授权变更保持撤销屏障，真实范围退出后回绕 %i",
  async (iteration) => {
    const { root, sandbox, scope, request } = await processFixture(
      `barrier-task-${iteration}`,
    );
    const release = join(root, "release.txt");
    const input = request(
      `const fs=require("node:fs");process.on("SIGTERM",()=>{process.stdout.write("terminating\\n");setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},10)});setInterval(()=>{},1000);process.stdin.resume();process.stdout.write("ready\\n")`,
    );
    const child = await sandbox.spawn(input);
    await expect
      .poll(
        async () =>
          (await child.readOutput({ offset: 0, maxBytes: 1024 })).data,
      )
      .toContain("ready");
    const first = sandbox.revokeTask(scope.taskId, 2, "first_revoke");
    void first.catch(() => {});
    await expect
      .poll(
        async () =>
          (await child.readOutput({ offset: 0, maxBytes: 1024 })).data,
      )
      .toContain("terminating");
    const second = sandbox.applyScopeChange(
      { ...scope, generation: 2 },
      { ...scope, generation: 3 },
      "second_change",
    );
    void second.catch(() => {});
    try {
      await Promise.race([second, delay(50)]);
      await expect(
        sandbox.spawn({
          ...request("process.exit(0)"),
          scope: { ...scope, generation: 3 },
          invocationId: "late-during-revoke",
        }),
      ).rejects.toMatchObject({ code: "scope_revoked" });
      await expect(child.writeStdin("late")).rejects.toMatchObject({
        code: "scope_revoked",
      });
    } finally {
      await writeFile(release, "exit");
      await Promise.all([first, second]);
    }
    expect(await child.waitForExit()).toMatchObject({
      stopped: true,
      rangeEmpty: true,
    });
  },
);

test("stdout 与 stderr 分开分页且共用总采集 cap，持久原始输出仍按到达顺序读取", async () => {
  const { sandbox, request } = await processFixture("streams-task");
  const input = request(
    'process.stdout.write("abc");process.stdin.once("data",()=>{process.stderr.write("warn");process.stdin.destroy()})',
  );
  input.limits.maxOutputBytes = 5;
  const child = await sandbox.spawn(input);
  await expect
    .poll(
      async () =>
        (await child.readOutput({ offset: 0, maxBytes: 16, stream: "stdout" }))
          .data,
    )
    .toBe("abc");
  await child.writeStdin("continue");
  await child.waitForExit();
  expect(
    await child.readOutput({ offset: 0, maxBytes: 16, stream: "stdout" }),
  ).toMatchObject({
    data: "abc",
    retainedBytes: 3,
    totalBytes: 3,
    discardedBytes: 0,
  });
  expect(
    await child.readOutput({ offset: 0, maxBytes: 16, stream: "stderr" }),
  ).toMatchObject({
    data: "wa",
    retainedBytes: 2,
    totalBytes: 4,
    discardedBytes: 2,
    truncated: true,
  });
  const merged = await child.readOutput({ offset: 0, maxBytes: 16 });
  expect(merged).toMatchObject({
    data: "abcwa",
    retainedBytes: 5,
    totalBytes: 7,
    discardedBytes: 2,
    done: true,
  });
  const snapshot = child.snapshot();
  await sandbox.closeTask(snapshot.ownerTaskId, "completed");
  expect(
    readCapturedOutput(
      snapshot.outputPath,
      snapshot,
      { offset: 0, maxBytes: 16 },
      true,
    ),
  ).toEqual(merged);
});

test("关闭代际拒绝迟到启动，可信新代际重开且不被旧关闭或撤销停止", async () => {
  const { sandbox, scope, request } = await processFixture("generation-task");
  const firstInput = request(
    'process.stdout.write("first");setInterval(()=>{},1000)',
  );
  const first = await sandbox.spawn(firstInput);
  await expect.poll(() => first.snapshot().state).toBe("running");
  await sandbox.closeTask(scope.taskId, "generation_closed", 1);
  expect(await first.waitForExit()).toMatchObject({
    stopped: true,
    rangeEmpty: true,
  });
  await expect(sandbox.spawn(firstInput)).rejects.toMatchObject({
    code: "process_closed",
  });
  await sandbox.applyScopeChange(
    scope,
    { ...scope, generation: 2 },
    "closed-task-permission-recovery",
  );
  await expect(sandbox.spawn(firstInput)).rejects.toMatchObject({
    code: "process_closed",
  });
  const nextInput = {
    ...request(
      'process.stdout.write("second");process.stdin.on("data",b=>process.stdout.write(b))',
    ),
    scope: { ...scope, generation: 2 },
    invocationId: "new-generation-call",
  };
  const second = await sandbox.spawn(nextInput);
  await expect
    .poll(
      async () => (await second.readOutput({ offset: 0, maxBytes: 1024 })).data,
    )
    .toContain("second");
  await expect(
    sandbox.closeTask(scope.taskId, "late_old_close", 1),
  ).rejects.toMatchObject({ code: "scope_revoked" });
  await expect(
    sandbox.revokeTask(scope.taskId, 1, "late_old_revoke"),
  ).rejects.toMatchObject({ code: "scope_revoked" });
  await second.writeStdin("still-authorized");
  await expect
    .poll(
      async () => (await second.readOutput({ offset: 0, maxBytes: 1024 })).data,
    )
    .toContain("still-authorized");
  await second.stop("done");
});

test("CJS 发布宿主不解析源码 URL，发布 helper 带固定依赖真实启动", async () => {
  const { fixture, request } = await processFixture("packaged-task");
  const resourceRoot = join(fixture, "published");
  const helperPath = join(resourceRoot, "process-helper", "task-helper.mjs");
  const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
  await promisify(execFile)(process.execPath, [
    join(moduleDirectory, "build-helper.mjs"),
    join(resourceRoot, "process-helper"),
  ]);
  const { build } = await import("esbuild");
  const resolverPath = join(fixture, "runtime-paths.cjs");
  await build({
    entryPoints: [join(moduleDirectory, "runtime-paths.ts")],
    outfile: resolverPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    define: { "import.meta.url": JSON.stringify("/published/server.cjs") },
    logLevel: "silent",
  });
  const resolver: typeof import("./runtime-paths.js") = createRequire(
    import.meta.url,
  )(resolverPath);
  const runtime = resolver.resolveProcessRuntime({ resourceRoot, env: {} });
  expect(runtime.helperPath).toBe(helperPath);
  const sandbox = createProcessSandbox({
    ...runtime,
    captureRoot: join(fixture, "packaged-capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  cleanups.push(() => sandbox.close("test_cleanup"));
  const child = await sandbox.spawn(
    request('process.stdout.write("packaged-helper")'),
  );
  expect(await child.waitForExit()).toMatchObject({
    exitCode: 0,
    rangeEmpty: true,
    stopped: false,
  });
  expect(await child.readOutput({ offset: 0, maxBytes: 1024 })).toMatchObject({
    data: "packaged-helper",
    done: true,
  });
});

test("provider只读执行保证来自固定无网profile，已有RW helper不会放大后续readonly调用", async () => {
  const { root, sandbox, request, scope } = await processFixture(
    "readonly-guarantee-task",
  );
  let requests = 0;
  const server = createServer((_input, response) => {
    requests++;
    response.end("outside");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  expect(sandbox.readonlyExecution).toBe(true);
  const deniedCapability = createProcessSandbox({
    captureRoot: join(root, "networked-capture"),
    network: { allowedDomains: ["example.com"], deniedDomains: [] },
  });
  cleanups.push(() => deniedCapability.close("cleanup"));
  expect(deniedCapability.readonlyExecution).toBe(false);
  const port = server.address();
  if (!port || typeof port === "string")
    throw new Error("测试server未分配TCP端口。");
  const file = join(root, "mode-proof.txt");
  const first = await sandbox.spawn(
    request(
      `require("node:fs").writeFileSync(${JSON.stringify(file)},"rw-created")`,
    ),
  );
  expect(await first.waitForExit()).toMatchObject({
    exitCode: 0,
    rangeEmpty: true,
  });
  const program = `try{require("node:fs").writeFileSync(${JSON.stringify(file)},"corrupt");process.stdout.write("WRITE-OPEN")}catch(e){process.stdout.write("write-denied\\n")}const r=require("node:http").get("http://127.0.0.1:${port.port}/",s=>{s.resume();process.stdout.write("NETWORK-OPEN");process.exitCode=9});r.on("error",()=>{process.stdout.write("network-denied");process.exitCode=0})`;
  const second = await sandbox.spawn({
    ...request(program),
    scope: { ...scope, sandboxMode: "read-only" },
    invocationId: "readonly-after-rw",
    timeoutMs: 2000,
  });
  expect(await second.waitForExit()).toMatchObject({
    exitCode: 0,
    rangeEmpty: true,
    stopped: false,
  });
  const output = await second.readOutput({ offset: 0, maxBytes: 4096 });
  expect(output.data).toContain("write-denied");
  expect(output.data).toContain("network-denied");
  expect(output.data).not.toContain("OPEN");
  expect(await readFile(file, "utf8")).toBe("rw-created");
  expect(requests).toBe(0);
});

test("恢复barrier拒绝其它Task活RW进程且不自动杀，持有期间拒新相交RW但允许readonly", async () => {
  const { root, sandbox, request, scope } =
    await processFixture("restore-owner");
  const otherScope = { ...scope, taskId: "other-writer" };
  const input = {
    ...request('process.stdout.write("writer-alive");setInterval(()=>{},1000)'),
    scope: otherScope,
    invocationId: "writer-before-restore",
  };
  const writer = await sandbox.spawn(input);
  await expect
    .poll(
      async () => (await writer.readOutput({ offset: 0, maxBytes: 1024 })).data,
    )
    .toContain("writer-alive");
  await expect(
    sandbox.acquireRestoreBarrier(scope, [root]),
  ).rejects.toMatchObject({ code: "restore_conflict", statusCode: 409 });
  expect(writer.snapshot().state).toBe("running");
  await writer.stop("explicit-user-stop");
  const barrier = await sandbox.acquireRestoreBarrier(scope, [root]);
  try {
    await expect(
      sandbox.spawn({
        ...input,
        argv: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
        invocationId: "late-rw",
      }),
    ).rejects.toMatchObject({ code: "restore_conflict", statusCode: 409 });
    const reader = await sandbox.spawn({
      ...input,
      scope: { ...otherScope, sandboxMode: "read-only" },
      argv: {
        executable: process.execPath,
        args: ["-e", 'process.stdout.write("readonly-during-restore")'],
      },
      invocationId: "readonly-during-restore",
    });
    expect(await reader.waitForExit()).toMatchObject({
      exitCode: 0,
      rangeEmpty: true,
    });
    expect(
      await reader.readOutput({ offset: 0, maxBytes: 1024 }),
    ).toMatchObject({ data: "readonly-during-restore" });
  } finally {
    await barrier.release();
    await barrier.release();
  }
  const marker = join(root, "after-restore.txt");
  const resumed = await sandbox.spawn({
    ...input,
    argv: {
      executable: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)},"released")`,
      ],
    },
    invocationId: "rw-after-release",
  });
  expect(await resumed.waitForExit()).toMatchObject({
    exitCode: 0,
    rangeEmpty: true,
  });
  expect(await readFile(marker, "utf8")).toBe("released");
});

test("恢复barrier也拒绝冷helper中的pending RW，readonly checkpoint先初始化不限制同Task后续mainRW", async () => {
  const { fixture, root, request, scope } = await processFixture(
    "restore-pending-owner",
  );
  let resolveNetwork!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    resolveNetwork = resolve;
  });
  const networkStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const metadata = join(fixture, "shadow-metadata");
  await mkdir(metadata);
  const sandbox = createProcessSandbox({
    captureRoot: join(fixture, "pending-capture"),
    network: { allowedDomains: [], deniedDomains: [] },
    resolveNetwork: async () => {
      started();
      await waiting;
      return { allowedDomains: [], deniedDomains: [] };
    },
    resolveInternalWriteRoots: async () => [metadata],
  });
  cleanups.push(() => sandbox.close("cleanup"));
  const otherScope = { ...scope, taskId: "cold-pending-writer" };
  const pending = sandbox.spawn({
    ...request('process.stdout.write("started-after-network-gate")'),
    scope: otherScope,
    invocationId: "pending-write",
  });
  void pending.catch(() => {});
  await networkStarted;
  try {
    await expect(
      sandbox.acquireRestoreBarrier(scope, [root]),
    ).rejects.toMatchObject({ code: "restore_conflict", statusCode: 409 });
  } finally {
    resolveNetwork();
  }
  const writer = await pending;
  expect(await writer.waitForExit()).toMatchObject({
    exitCode: 0,
    rangeEmpty: true,
  });
  const barrier = await sandbox.acquireRestoreBarrier(scope, [root]);
  const privateFile = join(metadata, "snapshot.txt");
  try {
    const snapshot = await sandbox.spawnCheckpoint({
      ...request(
        `require("node:fs").writeFileSync(${JSON.stringify(privateFile)},"private snapshot")`,
      ),
      scope: { ...scope, sandboxMode: "read-only" },
      agentId: "checkpoint-git",
      invocationId: "readonly-first-checkpoint",
    });
    expect(await snapshot.waitForExit()).toMatchObject({
      exitCode: 0,
      rangeEmpty: true,
    });
    expect(await readFile(privateFile, "utf8")).toBe("private snapshot");
  } finally {
    await barrier.release();
  }
  const mainFile = join(root, "main-after-readonly.txt");
  const main = await sandbox.spawn({
    ...request(
      `require("node:fs").writeFileSync(${JSON.stringify(mainFile)},"main writable")`,
    ),
    invocationId: "main-after-readonly-init",
  });
  expect(await main.waitForExit()).toMatchObject({
    exitCode: 0,
    rangeEmpty: true,
  });
  expect(await readFile(mainFile, "utf8")).toBe("main writable");
});

test("只读执行可使用Task私有HOME缓存，用户目录仍不可写", async () => {
  const { root, sandbox, request, scope } =
    await processFixture("private-home-task");
  const forbidden = join(root, "forbidden-user-write.txt");
  const program = `const fs=require("node:fs"),path=require("node:path"),home=require("node:os").homedir();fs.mkdirSync(path.join(home,"cache"),{recursive:true});const cache=path.join(home,"cache","proof.txt");fs.writeFileSync(cache,"private cache");process.stdout.write(fs.readFileSync(cache,"utf8"));try{fs.writeFileSync(${JSON.stringify(forbidden)},"corrupt");process.exitCode=9}catch(e){process.stdout.write(" user-write-denied")}`;
  const child = await sandbox.spawn({
    ...request(program),
    scope: { ...scope, sandboxMode: "read-only" },
  });
  const exit = await child.waitForExit();
  const output = await child.readOutput({ offset: 0, maxBytes: 4096 });
  expect(exit, output.data).toMatchObject({ exitCode: 0, rangeEmpty: true });
  expect(output).toMatchObject({ data: "private cache user-write-denied" });
  await expect(readFile(forbidden, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test.each([1, 2, 3, 4, 5, 6, 7, 8])(
  "冷pending写域的恢复竞争不撤销原命令，拒绝恢复后仍真实启动 %i",
  async (iteration) => {
    const { fixture, root, request, scope } = await processFixture(
      `pending-race-owner-${iteration}`,
    );
    const reference = join(fixture, "readonly-reference");
    await mkdir(reference);
    let release!: () => void;
    let began!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const sandbox = createProcessSandbox({
      captureRoot: join(fixture, "cold-race-capture"),
      network: { allowedDomains: [], deniedDomains: [] },
      resolveNetwork: async () => {
        began();
        await gate;
        return { allowedDomains: [], deniedDomains: [] };
      },
    });
    cleanups.push(() => sandbox.close("cleanup"));
    const foreignScope = {
      ...scope,
      taskId: `foreign-pending-${iteration}`,
      additionalDirectories: [
        { path: reference, access: "read-only" as const },
      ],
    };
    const pending = sandbox.spawn({
      ...request('process.stdout.write("pending-command-preserved")'),
      scope: foreignScope,
      invocationId: `pending-race-${iteration}`,
    });
    void pending.catch(() => {});
    await started;
    try {
      await expect(
        sandbox.acquireRestoreBarrier(scope, [root]),
      ).rejects.toMatchObject({ code: "restore_conflict", statusCode: 409 });
    } finally {
      release();
    }
    const child = await pending;
    expect(await child.waitForExit()).toMatchObject({
      exitCode: 0,
      rangeEmpty: true,
    });
    expect(await child.readOutput({ offset: 0, maxBytes: 1024 })).toMatchObject(
      { data: "pending-command-preserved" },
    );
  },
);

test("初始化失败后的命令报沙箱初始化失败原因，不再伪装成授权代际失效", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-init-failure-")),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sandbox = createProcessSandbox({
    captureRoot: join(root, "capture"),
    // 指向不存在的 helper：初始化必然失败（helper 进程无法启动）。
    helperPath: join(root, "missing-helper.mjs"),
    nodePath: process.execPath,
    network: { allowedDomains: [], deniedDomains: [] },
  });
  cleanups.push(() => sandbox.close("cleanup").catch(() => {}));
  const scope: CodeExecutionScope = {
    instanceId: "test-workspace",
    projectId: "test-project",
    taskId: "init-failure-task",
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  const base: Omit<ProcessSpawnRequest, "invocationId"> = {
    scope,
    agentId: "main",
    command: "echo unreachable",
    background: false,
    timeoutMs: null,
    limits: {
      maxOutputBytes: 65536,
      previewMaxChars: 8000,
      yieldMs: 20,
      killGraceMs: 2000,
    },
  };
  // 第一次调用暴露原始初始化错误（helper 启动失败）。
  await expect(
    sandbox.spawn({ ...base, invocationId: "init-failure-1" }),
  ).rejects.toThrow();
  // 后续调用必须指出「初始化失败」并带上原因，而不是冒充授权代际失效。
  await expect(
    sandbox.spawn({ ...base, invocationId: "init-failure-2" }),
  ).rejects.toMatchObject({
    code: "enforcement_unavailable",
    message: expect.stringContaining("初始化失败"),
  });
});
