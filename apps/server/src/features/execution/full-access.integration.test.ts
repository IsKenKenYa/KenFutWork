import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxMode } from "@kenfutwork/shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createCodeFileTools } from "../code-tools/tool-definitions.js";
import { createScopedExecute } from "../process-sandbox/consumer.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import type {
  ScopeRepository,
  StoredExecutionScope,
} from "./scope-repository.js";
import {
  createExecutionScopes,
  type ExecutionScopeHandle,
} from "./scope-service.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

async function fixture(mode: SandboxMode) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-full-access-")),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  const outside = join(directory, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  const source = join(outside, "source.txt");
  await writeFile(source, "outside source\n");
  const actor = { instanceId: randomUUID(), accessClientId: null };
  let stored: StoredExecutionScope = {
    preset: "code",
    state: "ready",
    branchGeneration: 1,
    scope: {
      instanceId: actor.instanceId,
      projectId: randomUUID(),
      taskId: randomUUID(),
      generation: 1,
      rootDirectory: root,
      additionalDirectories: [],
      sandboxMode: mode,
    },
  };
  const repository: ScopeRepository = {
    load: async () => structuredClone(stored),
    async beginUpdate(previous, patch) {
      if (
        stored.state !== "ready" ||
        previous.generation !== stored.scope.generation
      )
        return null;
      stored = {
        ...stored,
        state: "revoking",
        scope: {
          ...stored.scope,
          sandboxMode: patch.sandboxMode ?? stored.scope.sandboxMode,
          additionalDirectories:
            patch.additionalDirectories ?? stored.scope.additionalDirectories,
          generation: previous.generation + 1,
        },
      };
      return structuredClone(stored);
    },
    async finishUpdate(scope, state) {
      if (scope.generation !== stored.scope.generation) return false;
      stored = { ...stored, state };
      return true;
    },
  };
  const scopes = createExecutionScopes({
    repository,
    localInstance: {
      resolve: async () => ({
        instanceId: actor.instanceId,
        dataDir: directory,
      }),
    },
  });
  const handle = await scopes.openTask(actor, stored.scope.taskId);
  const sandbox = createProcessSandbox({
    captureRoot: join(directory, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  cleanups.push(() => sandbox.close("full_access_test_cleanup"));
  scopes.onRevoke(({ previous, next }) =>
    sandbox.applyScopeChange(previous, next, "full_access_downgrade"),
  );
  const tools = createCodeFileTools({
    backend: handle.backend,
    modelCapabilities: { image: false, pdf: false },
  });
  const tool = (name: string) => {
    const found = tools.find((tool) => tool.name === name);
    if (!found) throw new Error(`缺少 ${name}`);
    return found;
  };
  const execute = (
    program: string,
    invocationId: string,
    scope: ExecutionScopeHandle = handle,
  ) =>
    createScopedExecute(sandbox, scope, {
      agentId: scope.agentId,
      invocationId,
      limits: {
        maxOutputBytes: 65536,
        previewMaxChars: 8000,
        yieldMs: 50,
        killGraceMs: 2000,
      },
    })({
      command: `${quote(process.execPath)} -e ${quote(program)}`,
      background: true,
      timeoutMs: 10_000,
    });
  return { actor, scopes, handle, tool, execute, source, root, outside };
}

describe.skipIf(
  process.env.RUN_FULL_ACCESS_INTEGRATION !== "1" ||
    !["darwin", "linux"].includes(process.platform),
)("真实OS账户级完全访问（不声明root权限）", () => {
  it.each([
    { mode: "workspace-write", operation: "Read" },
    { mode: "workspace-write", operation: "Write" },
    { mode: "danger-full-access", operation: "Read" },
    { mode: "danger-full-access", operation: "Write" },
  ] as const)(
    "$mode 的 $operation 按真实文件权限处理外部临时目录",
    async ({ mode, operation }) => {
      const f = await fixture(mode);
      const context = { scopeHandle: f.handle, toolCallId: "outside-file" };
      const target = join(f.outside, "written.txt");
      const pending = f
        .tool(operation)
        .execute(
          operation === "Read"
            ? { file_path: f.source }
            : { file_path: target, content: "file tool wrote\n" },
          context,
        );
      if (mode === "workspace-write") {
        await expect(pending).rejects.toMatchObject({ code: "path_denied" });
        await expect(readFile(target)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else if (operation === "Read") {
        expect(await pending).toMatchObject({
          canonicalOutput: { content: "outside source\n" },
        });
      } else {
        await pending;
        expect(await readFile(target, "utf8")).toBe("file tool wrote\n");
      }
    },
  );

  it.each(["workspace-write", "danger-full-access"] as const)(
    "%s 的真实Bash按权限访问外部文件和临时loopback HTTP",
    async (mode) => {
      const f = await fixture(mode);
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.end("network-ok");
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
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("本机测试服务未分配端口");
      const target = join(f.outside, "shell-written.txt");
      const program = `const fs=require('node:fs'),http=require('node:http');const result={};try{result.read=fs.readFileSync(${JSON.stringify(f.source)},'utf8')}catch{result.read='denied'}try{fs.writeFileSync(${JSON.stringify(target)},'shell wrote');result.write='allowed'}catch{result.write='denied'}const request=http.get('http://127.0.0.1:${address.port}/',response=>{let data='';response.on('data',chunk=>data+=chunk);response.on('end',()=>{result.network=data;process.stdout.write(JSON.stringify(result))})});request.on('error',error=>{result.network=error.code==='KFW_TIMEOUT'?'timeout':'denied';process.stdout.write(JSON.stringify(result))});request.setTimeout(1500,()=>request.destroy(Object.assign(new Error('timeout'),{code:'KFW_TIMEOUT'})));`;
      const child = await f.execute(program, `outside-network-${mode}`);
      const exit = await child.waitForExit();
      const output = await child.readOutput({ offset: 0, maxBytes: 8192 });
      expect(exit, output.data).toMatchObject({
        exitCode: 0,
        rangeEmpty: true,
        stopped: false,
      });
      expect(child.snapshot().enforcement).toMatchObject(
        mode === "danger-full-access"
          ? {
              backend: "host-account",
              filesystem: "unrestricted",
              network: "unrestricted",
              processRange: "process-group",
              permissionsGeneration: 1,
            }
          : { filesystem: "enforced", permissionsGeneration: 1 },
      );
      const result = z
        .object({ read: z.string(), write: z.string(), network: z.string() })
        .parse(JSON.parse(output.data));
      expect(result).toEqual(
        mode === "danger-full-access"
          ? {
              read: "outside source\n",
              write: "allowed",
              network: "network-ok",
            }
          : { read: "denied", write: "denied", network: "denied" },
      );
      expect(requests).toBe(mode === "danger-full-access" ? 1 : 0);
      if (mode === "danger-full-access")
        expect(await readFile(target, "utf8")).toBe("shell wrote");
      else
        await expect(readFile(target)).rejects.toMatchObject({
          code: "ENOENT",
        });
      if (mode === "danger-full-access") {
        const plan = await f.execute(
          program,
          "plan-after-full-access",
          f.handle.restrictReadOnly(),
        );
        const planExit = await plan.waitForExit();
        const planOutput = await plan.readOutput({ offset: 0, maxBytes: 8192 });
        expect(planExit, planOutput.data).toMatchObject({
          exitCode: 0,
          rangeEmpty: true,
        });
        expect(JSON.parse(planOutput.data)).toEqual({
          read: "denied",
          write: "denied",
          network: "denied",
        });
        expect(requests).toBe(1);
        expect(plan.snapshot().enforcement?.filesystem).toBe("enforced");
      }
    },
    30_000,
  );

  it.each(["explore", "review"] as const)(
    "完全访问的%s子角色仍只读且不能派生可写后代",
    async (role) => {
      const f = await fixture("danger-full-access");
      const child = f.handle.derive(role, "readonly-agent");
      expect(await child.resolvePath(f.source, "read")).toBe(f.source);
      await expect(
        child.resolvePath(join(f.outside, "forbidden.txt"), "write"),
      ).rejects.toMatchObject({ code: "read_only" });
      await expect(
        child
          .derive("worker", "descendant")
          .resolvePath(join(f.outside, "forbidden.txt"), "write"),
      ).rejects.toMatchObject({ code: "read_only" });
      expect(await readFile(f.source, "utf8")).toBe("outside source\n");
    },
  );

  it("完全访问降为workspace-write时收回旧代际后台进程", async () => {
    const f = await fixture("danger-full-access");
    const marker = join(f.root, "background.log");
    const child = await f.execute(
      `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'ready\\n');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'tick\\n'),50)`,
      "downgrade-background",
    );
    await expect
      .poll(async () => readFile(marker, "utf8"), { timeout: 5000 })
      .toContain("ready");
    await f.scopes.updateTask(f.actor, f.handle.describe().taskId, {
      sandboxMode: "workspace-write",
    });
    await expect
      .poll(() => child.snapshot().exit?.rangeEmpty, { timeout: 5000 })
      .toBe(true);
    expect(await child.waitForExit()).toMatchObject({
      stopped: true,
      rangeEmpty: true,
      reason: "full_access_downgrade",
    });
    await expect(child.writeStdin("late input")).rejects.toThrow();
    await expect(f.handle.resolvePath(f.source, "read")).rejects.toMatchObject({
      code: "path_denied",
    });
  }, 30_000);
});
