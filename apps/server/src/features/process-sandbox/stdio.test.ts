import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createProcessSandbox } from "./service.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.skipIf(process.platform === "win32")(
  "公共 stdio 提供真实 pipes、完整独立 stdout/stderr、跨帧 UTF8 与 stdin EOF，capture 截断不截协议",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-stdio-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sandbox = createProcessSandbox({
      captureRoot: join(root, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
    });
    cleanups.push(() => sandbox.close("test_cleanup"));
    const child = await sandbox.spawnStdio({
      scope: {
        instanceId: "workspace",
        projectId: "project",
        taskId: "stdio-task",
        generation: 1,
        rootDirectory: root,
        additionalDirectories: [],
        sandboxMode: "read-only",
      },
      agentId: "mcp-main",
      invocationId: "stdio-tracer",
      background: true,
      timeoutMs: null,
      argv: {
        executable: process.execPath,
        args: [
          "-e",
          'process.stdout.write("READY:pipe="+!process.stdin.isTTY+";env="+process.env.KFW_STDIO_EXPLICIT+"\\n");process.stderr.write("ERR_START\\n");process.stdin.once("data",()=>{process.stdout.write("X".repeat(1024));process.stdout.write(Buffer.from([0xe4,0xb8]));setImmediate(()=>process.stdout.write(Buffer.from([0xad,0x0a])))});process.stdin.on("end",()=>{process.stdout.write("EOF_DONE\\n");process.stderr.write("ERR_END\\n")})',
        ],
      },
      env: { KFW_STDIO_EXPLICIT: "literal-value" },
      limits: {
        maxOutputBytes: 128,
        previewMaxChars: 8000,
        yieldMs: 50,
        killGraceMs: 2000,
      },
    });
    let stdout = "";
    let stderr = "";
    const out = child.onStdout((data) => {
      stdout += data;
    });
    const err = child.onStderr((data) => {
      stderr += data;
    });
    cleanups.push(async () => {
      out();
      err();
    });
    await expect
      .poll(() => stdout)
      .toContain("READY:pipe=true;env=literal-value\n");
    await expect.poll(() => stderr).toContain("ERR_START\n");
    await child.writeStdin("request\n");
    await expect.poll(() => stdout).toContain("中\n");
    await child.endStdin();
    expect(await child.waitForExit()).toMatchObject({
      exitCode: 0,
      rangeEmpty: true,
    });
    expect(stdout.endsWith("EOF_DONE\n")).toBe(true);
    expect(stderr).toBe("ERR_START\nERR_END\n");
    expect(stdout).not.toContain("ERR_");
    const capture = await child.readOutput({ offset: 0, maxBytes: 128 });
    expect(capture.retainedBytes).toBe(128);
    expect(capture.truncated).toBe(true);
    expect(capture.data).not.toContain("EOF_DONE");
  },
);
