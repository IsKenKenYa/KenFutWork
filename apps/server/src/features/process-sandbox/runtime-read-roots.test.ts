import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { afterEach, expect, test } from "vitest";
import { createProcessSandbox } from "./service.js";
import type { ProcessStdioSpawnRequest } from "./types.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-runtime-read-")),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  const runtime = join(directory, "applications", "FreeCAD.app", "Contents");
  const sibling = join(directory, "applications", "Other.app");
  await Promise.all([
    mkdir(project),
    mkdir(runtime, { recursive: true }),
    mkdir(sibling, { recursive: true }),
  ]);
  await writeFile(join(runtime, "library.txt"), "installed runtime");
  await writeFile(join(sibling, "private.txt"), "unrelated application");
  const sandbox = createProcessSandbox({
    captureRoot: join(directory, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  cleanups.push(() => sandbox.close("test_cleanup"));
  const scope: CodeExecutionScope = {
    instanceId: "instance",
    projectId: "project",
    taskId: "runtime-task",
    generation: 1,
    rootDirectory: project,
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  };
  const request: ProcessStdioSpawnRequest = {
    scope,
    agentId: "main",
    invocationId: "runtime-proof",
    argv: { executable: process.execPath, args: [] },
    background: true,
    timeoutMs: 5000,
    limits: {
      maxOutputBytes: 65536,
      previewMaxChars: 8000,
      yieldMs: 50,
      killGraceMs: 2000,
    },
  };
  return { directory, project, runtime, sibling, sandbox, scope, request };
}

test.skipIf(process.platform === "win32")(
  "本次可信运行时根仅可读、不能读取同目录其他应用，且不污染已存在或新建Task helper的后续命令",
  async () => {
    const f = await fixture();
    const alias = join(f.directory, "runtime-alias");
    await symlink(f.runtime, alias, "dir");
    const library = join(f.runtime, "library.txt");
    const projectOutput = join(f.project, "output.txt");
    const program = `const fs=require("node:fs");const result={};try{result.runtime=fs.readFileSync(${JSON.stringify(library)},"utf8")}catch{result.runtime="denied"}try{fs.writeFileSync(${JSON.stringify(library)},"corrupt");result.write="allowed"}catch{result.write="denied"}try{fs.readFileSync(${JSON.stringify(join(f.sibling, "private.txt"))});result.sibling="allowed"}catch{result.sibling="denied"}fs.writeFileSync(${JSON.stringify(projectOutput)},"project output");process.stdout.write(JSON.stringify(result));`;
    for (const warmFirst of [false, true]) {
      const scope = { ...f.scope, taskId: `runtime-${warmFirst}` };
      const execute = async (
        invocationId: string,
        runtimeReadRoots?: readonly string[],
      ) => {
        const child = await f.sandbox.spawnStdio({
          ...f.request,
          scope,
          invocationId,
          argv: { executable: process.execPath, args: ["-e", program] },
          ...(runtimeReadRoots ? { runtimeReadRoots } : {}),
        });
        let stdout = "";
        const unsubscribe = child.onStdout((data) => {
          stdout += data;
        });
        child.onStderr(() => {});
        try {
          expect(await child.waitForExit(), stdout).toMatchObject({
            exitCode: 0,
            rangeEmpty: true,
          });
          return JSON.parse(stdout);
        } finally {
          unsubscribe();
        }
      };
      if (warmFirst)
        expect(await execute("warm")).toEqual({
          runtime: "denied",
          write: "denied",
          sibling: "denied",
        });
      expect(await execute("runtime", [alias, f.runtime])).toEqual({
        runtime: "installed runtime",
        write: "denied",
        sibling: "denied",
      });
      expect(await execute("after-runtime")).toEqual({
        runtime: "denied",
        write: "denied",
        sibling: "denied",
      });
    }
    expect(await readFile(library, "utf8")).toBe("installed runtime");
    expect(await readFile(projectOutput, "utf8")).toBe("project output");
  },
);

test.skipIf(process.platform === "win32")(
  "运行时根不会绕过Task撤权；停止确认退出后拒绝旧代际重放",
  async () => {
    const f = await fixture();
    const child = await f.sandbox.spawnStdio({
      ...f.request,
      timeoutMs: null,
      runtimeReadRoots: [f.runtime],
      argv: {
        executable: process.execPath,
        args: [
          "-e",
          `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(join(f.runtime, "library.txt"))},"utf8"));setInterval(()=>{},1000);`,
        ],
      },
    });
    let stdout = "";
    child.onStdout((data) => {
      stdout += data;
    });
    child.onStderr(() => {});
    await expect.poll(() => stdout).toBe("installed runtime");
    await f.sandbox.applyScopeChange(
      f.scope,
      { ...f.scope, generation: 2, sandboxMode: "read-only" },
      "runtime_scope_revoked",
    );
    expect(await child.waitForExit()).toMatchObject({
      stopped: true,
      reason: "runtime_scope_revoked",
      rangeEmpty: true,
    });
    await expect(
      f.sandbox.spawnStdio({
        ...f.request,
        invocationId: "late-runtime",
        runtimeReadRoots: [f.runtime],
      }),
    ).rejects.toMatchObject({ code: "scope_revoked" });
  },
);

test("运行时根必须是已存在的绝对目录，拒绝相对路径和普通文件", async () => {
  const f = await fixture();
  await expect(
    f.sandbox.spawn({ ...f.request, runtimeReadRoots: ["."] }),
  ).rejects.toMatchObject({ code: "invalid_process_request" });
  await expect(
    f.sandbox.spawn({
      ...f.request,
      runtimeReadRoots: [join(f.runtime, "library.txt")],
    }),
  ).rejects.toMatchObject({ code: "invalid_process_request" });
});

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "macOS ARM仅放行Qt需要的具体NEON检测，不放开其他sysctl读取",
  async () => {
    const f = await fixture();
    const source = join(f.project, "sysctl-probe.c");
    const executable = join(f.project, "sysctl-probe");
    // sysctl CLI还要查询OID格式元数据；Qt直接调用sysctlbyname，只验证同一API。
    await writeFile(
      source,
      String.raw`#include <sys/types.h>
#include <sys/sysctl.h>
#include <errno.h>
#include <stdio.h>
int main(void) {
  int neon = 0, restricted = 0;
  size_t neonSize = sizeof(neon), restrictedSize = sizeof(restricted);
  errno = 0;
  int neonStatus = sysctlbyname("hw.optional.neon", &neon, &neonSize, NULL, 0);
  int neonError = errno;
  errno = 0;
  int restrictedStatus = sysctlbyname("kern.maxprocperuid", &restricted, &restrictedSize, NULL, 0);
  int restrictedError = errno;
  printf("{\"neon\":{\"status\":%d,\"errno\":%d,\"value\":%d},\"restricted\":{\"status\":%d,\"errno\":%d}}",
    neonStatus, neonError, neon, restrictedStatus, restrictedError);
  return 0;
}
`,
    );
    await promisify(execFile)(
      "/usr/bin/cc",
      ["-std=c11", source, "-o", executable],
      { timeout: 10_000, maxBuffer: 65_536 },
    );
    const child = await f.sandbox.spawn({
      ...f.request,
      scope: { ...f.scope, sandboxMode: "read-only" },
      argv: { executable, args: [] },
    });
    expect(await child.waitForExit()).toMatchObject({
      exitCode: 0,
      rangeEmpty: true,
    });
    const output = JSON.parse(
      (await child.readOutput({ offset: 0, maxBytes: 8192 })).data,
    );
    expect(output.neon).toEqual({ status: 0, errno: 0, value: 1 });
    expect(output.restricted).toEqual({
      status: -1,
      errno: constants.errno.EPERM,
    });
  },
);
