import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { afterEach, expect, test } from "vitest";
import { createProcessSandbox } from "./service.js";
import type { ProcessLimits } from "./types.js";

// Explicit real-host suite: source/crosscompile/portable stubs are never counted as this evidence.
const enabled =
  process.platform === "win32" &&
  process.env.KENFUTWORK_WINDOWS_NATIVE_TESTS === "1";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const limits: ProcessLimits = {
  maxOutputBytes: 65536,
  previewMaxChars: 8000,
  yieldMs: 50,
  killGraceMs: 2000,
};
async function fixture() {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-win-native-")),
  );
  cleanups.push(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "project"),
    reference = join(temporary, "reference");
  await mkdir(root);
  await mkdir(reference);
  const sandbox = createProcessSandbox({
    captureRoot: join(temporary, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
    ...(process.env.KENFUTWORK_WINDOWS_BROKER_PATH
      ? { windowsBrokerPath: process.env.KENFUTWORK_WINDOWS_BROKER_PATH }
      : {}),
  });
  cleanups.push(() => sandbox.close("integration_cleanup"));
  const scope: CodeExecutionScope = {
    instanceId: "workspace",
    projectId: "project",
    taskId: "windows-task",
    generation: 1,
    rootDirectory: root,
    additionalDirectories: [{ path: reference, access: "read-only" }],
    sandboxMode: "workspace-write",
  };
  return { temporary, root, reference, sandbox, scope };
}

test.skipIf(!enabled)(
  "Windows真实ConPTY保持TTY、raw按键、resize与PSEC目录授权",
  async () => {
    const { temporary, reference, sandbox, scope } = await fixture();
    const outside = join(temporary, "outside.txt"),
      readonly = join(reference, "allowed.txt");
    await writeFile(outside, "outside");
    await writeFile(readonly, "reference");
    const program = `const fs=require("node:fs");if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error("not-tty");process.stdin.setRawMode(true);let outside=false,readonly=false;try{fs.readFileSync(${JSON.stringify(outside)})}catch(e){outside=true}try{fs.writeFileSync(${JSON.stringify(readonly)},"escape")}catch(e){readonly=true}process.stdout.write("NATIVE_TTY_READY\\nACCESS:"+outside+":"+readonly+":"+fs.readFileSync(${JSON.stringify(readonly)},"utf8")+"\\n");let keys=Buffer.alloc(0);process.stdin.on("data",b=>{keys=Buffer.concat([keys,b]);process.stdout.write("KEY:"+keys.toString("hex")+"\\n")});process.stdout.on("resize",()=>process.stdout.write("SIZE:"+process.stdout.rows+"x"+process.stdout.columns+"\\n"))`;
    const child = await sandbox.spawnPty({
      scope,
      agentId: "human-terminal",
      invocationId: "native-tty",
      argv: { executable: process.execPath, args: ["-e", program] },
      pty: { cols: 90, rows: 30 },
      background: true,
      timeoutMs: null,
      limits,
    });
    let output = "";
    const dispose = child.onOutput((data) => {
      output += data;
    });
    cleanups.push(async () => {
      dispose();
    });
    await expect.poll(() => output).toContain("ACCESS:true:true:reference");
    expect(child.snapshot().enforcement).toMatchObject({
      backend: "windows-task-broker",
      filesystem: "enforced",
      processRange: "job-object",
    });
    await child.resize(111, 36);
    await child.writeStdin("\x1b[A\x03");
    await expect.poll(() => output).toContain("SIZE:36x111");
    await expect.poll(() => output).toContain("KEY:1b5b4103");
    expect((await child.stop("terminal_disposed")).rangeEmpty).toBe(true);
    expect(await readFile(readonly, "utf8")).toBe("reference");
  },
  60000,
);

test.skipIf(!enabled)(
  "Windows真实PowerShell交互宿主保留PSReadLine与Console输入输出",
  async () => {
    const { sandbox, scope } = await fixture();
    const shell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = await sandbox.spawnPty({
      scope,
      agentId: "human-terminal",
      invocationId: "psreadline",
      argv: { executable: shell, args: ["-NoLogo", "-NoProfile"] },
      pty: { cols: 100, rows: 32 },
      background: true,
      timeoutMs: null,
      limits,
    });
    let output = "";
    const dispose = child.onOutput((data) => {
      output += data;
    });
    cleanups.push(async () => {
      dispose();
    });
    await child.writeStdin(
      "[Console]::WriteLine(('__KFW_PS_TTY:{0}:{1}:{2}' -f (![Console]::IsInputRedirected), (![Console]::IsOutputRedirected), ($null -ne (Get-Module PSReadLine))))\r",
    );
    await expect
      .poll(() => output, { timeout: 15000 })
      .toContain("__KFW_PS_TTY:True:True:True");
    expect((await child.stop("terminal_disposed")).rangeEmpty).toBe(true);
  },
  60000,
);

test.skipIf(!enabled).each(["stop", "exit", "revoke"])(
  "Windows真实Job在%s后清空后台写入，不把foreground exit当范围为空",
  async (action) => {
    const { root, sandbox, scope } = await fixture();
    const marker = join(root, "heartbeat.txt");
    const background = `const fs=require("node:fs");let count=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)},String(++count)),20)`;
    const program = `const cp=require("node:child_process");cp.spawn(process.execPath,["-e",${JSON.stringify(background)}],{stdio:"inherit"});process.stdin.setRawMode(true);process.stdin.once("data",()=>process.exit(0));process.stdout.write("JOB_PARENT_READY\\n")`;
    const child = await sandbox.spawnPty({
      scope,
      agentId: "human-terminal",
      invocationId: "native-jobs",
      argv: { executable: process.execPath, args: ["-e", program] },
      pty: { cols: 80, rows: 24 },
      background: true,
      timeoutMs: null,
      limits,
    });
    const dispose = child.onOutput(() => {});
    cleanups.push(async () => {
      dispose();
    });
    await expect
      .poll(async () => {
        try {
          return Number(await readFile(marker, "utf8"));
        } catch {
          return 0;
        }
      })
      .toBeGreaterThan(0);
    if (action === "exit") await child.writeStdin("exit");
    if (action === "revoke")
      await sandbox.revokeTask(scope.taskId, 2, "permissions_changed");
    const exit =
      action === "stop"
        ? await child.stop("terminal_disposed")
        : await child.waitForExit();
    expect(exit.rangeEmpty).toBe(true);
    const stopped = await readFile(marker, "utf8");
    await delay(150);
    expect(await readFile(marker, "utf8")).toBe(stopped);
  },
  60000,
);

test.skipIf(!enabled)(
  "Windows真实双流stdio提供独立UTF8/ACK/EOF，历史cap不截协议",
  async () => {
    const { sandbox, scope } = await fixture();
    const child = await sandbox.spawnStdio({
      scope: { ...scope, sandboxMode: "read-only" },
      agentId: "mcp-main",
      invocationId: "native-stdio",
      argv: {
        executable: process.execPath,
        args: [
          "-e",
          'process.stdout.write("READY:"+!process.stdin.isTTY+"\\n");process.stderr.write("ERR_START\\n");process.stdin.once("data",()=>{process.stdout.write("X".repeat(1024));process.stdout.write(Buffer.from([0xe4,0xb8]));setImmediate(()=>process.stdout.write(Buffer.from([0xad,0x0a])))});process.stdin.on("end",()=>{process.stdout.write("EOF_DONE\\n");process.stderr.write("ERR_END\\n")})',
        ],
      },
      background: true,
      timeoutMs: null,
      limits: { ...limits, maxOutputBytes: 128 },
    });
    let stdout = "",
      stderr = "";
    const out = child.onStdout((data) => {
        stdout += data;
      }),
      err = child.onStderr((data) => {
        stderr += data;
      });
    cleanups.push(async () => {
      out();
      err();
    });
    await expect.poll(() => stdout).toContain("READY:true");
    await expect.poll(() => stderr).toContain("ERR_START");
    await child.writeStdin("request\n");
    await expect.poll(() => stdout).toContain("中\n");
    await child.endStdin();
    expect(await child.waitForExit()).toMatchObject({
      exitCode: 0,
      rangeEmpty: true,
    });
    expect(stdout.endsWith("EOF_DONE\n")).toBe(true);
    expect(stderr).toBe("ERR_START\nERR_END\n");
    const capture = await child.readOutput({ offset: 0, maxBytes: 128 });
    expect(capture.retainedBytes).toBe(128);
    expect(capture.truncated).toBe(true);
    expect(capture.data).not.toContain("EOF_DONE");
  },
  60000,
);
