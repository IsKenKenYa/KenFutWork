import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createProcessSandbox } from "./service.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.skipIf(process.platform !== "linux")(
  "Linux 真 PTY 保留 controlling terminal/resize，命令在独立 PID namespace 与 Task 文件授权内",
  async () => {
    const fixture = await realpath(
      await mkdtemp(join(tmpdir(), "kfw-linux-pty-")),
    );
    cleanups.push(() => rm(fixture, { recursive: true, force: true }));
    const root = join(fixture, "project");
    const reference = join(fixture, "reference");
    await mkdir(root);
    await mkdir(reference);
    const allowed = join(reference, "allowed.txt");
    const denied = join(fixture, "outside.txt");
    await writeFile(allowed, "reference");
    await writeFile(denied, "must-not-read");
    const hostNamespace = await readlink("/proc/self/ns/pid");
    const sandbox = createProcessSandbox({
      captureRoot: join(fixture, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
    });
    cleanups.push(() => sandbox.close("test_cleanup"));
    const program = `const fs=require("node:fs");if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error("not-tty");process.stdin.setRawMode(true);process.stdout.on("resize",()=>process.stdout.write("SIZE:"+process.stdout.rows+"x"+process.stdout.columns+"\\n"));let denied=false;try{fs.readFileSync(${JSON.stringify(denied)})}catch(e){denied=true}let readonly=false;try{fs.writeFileSync(${JSON.stringify(allowed)},"escape")}catch(e){readonly=true}process.stdout.write("TTY_READY\\nPIDNS:"+fs.readlinkSync("/proc/self/ns/pid")+"\\nACCESS:"+denied+":"+readonly+":"+fs.readFileSync(${JSON.stringify(allowed)},"utf8")+"\\n");process.stdin.on("data",b=>process.stdout.write("KEY:"+b.toString("hex")+"\\n"))`;
    const child = await sandbox.spawnPty({
      scope: {
        workspaceId: "workspace",
        projectId: "project",
        taskId: "linux-pty-task",
        generation: 1,
        rootDirectory: root,
        additionalDirectories: [{ path: reference, access: "read-only" }],
        sandboxMode: "workspace-write",
      },
      agentId: "human-terminal",
      invocationId: "linux-pty-tracer",
      argv: { executable: process.execPath, args: ["-e", program] },
      pty: { cols: 90, rows: 30 },
      background: true,
      timeoutMs: null,
      limits: {
        maxOutputBytes: 65536,
        previewMaxChars: 8000,
        yieldMs: 50,
        killGraceMs: 2000,
      },
    });
    let output = "";
    const dispose = child.onOutput((data) => {
      output += data;
    });
    cleanups.push(async () => {
      dispose();
    });
    await expect.poll(() => output).toContain("TTY_READY");
    await expect.poll(() => output).toContain("ACCESS:true:true:reference");
    expect(output).not.toContain(`PIDNS:${hostNamespace}`);
    expect(child.snapshot().enforcement?.processRange).toBe("pid-namespace");
    await child.resize(111, 36);
    await expect.poll(() => output).toContain("SIZE:36x111");
    await child.writeStdin("\u001b[A\u0003");
    await expect.poll(() => output).toContain("KEY:1b5b4103");
    expect((await child.stop("terminal_disposed")).rangeEmpty).toBe(true);
    expect(await readFile(allowed, "utf8")).toBe("reference");
  },
  20000,
);
