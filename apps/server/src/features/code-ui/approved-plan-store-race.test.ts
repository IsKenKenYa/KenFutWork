import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_GOVERNANCE_LIMITS } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { createCodeApprovedPlanStore } from "./approved-plan-store.js";

// 独占macOS真实FD与文件系统竞态；普通全量test不启动OS探针，其他平台未实测。
describe.skipIf(
  process.platform !== "darwin" || process.env.RUN_CODE_UI_INTEGRATION !== "1",
)("批准计划真实FD管理目录竞态 integration", () => {
  it("已打开的计划父目录移出管理树再用软链接回，不发布越界正文", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kfw-plan-fd-race-"));
    let probe: ReturnType<typeof spawn> | undefined;
    try {
      const store = createCodeApprovedPlanStore();
      const identity = {
        instanceId: "fd-race-owner",
        taskId: "fc000aaa-bb11-4c22-9d33-000000000066",
        runId: "fd-run",
        toolCallId: "fd-call",
        agentId: "main",
        role: "main" as const,
        scopeGeneration: 1,
        branchGeneration: 1,
        planningEpoch: 3,
      };
      // 使用正式可调读取上界确保FD探针能观察在途读取，不修改生产chunk/等待逻辑。
      const maxBytes = AGENT_GOVERNANCE_LIMITS.codeReadMaxBytes.max;
      const plan = "x".repeat(maxBytes);
      const ref = await store.save(directory, identity, plan);
      const target = await realpath(resolve(directory, ref.relativePath));
      const escaped = join(await realpath(directory), "outside-agent-files");
      const script = `
          import { execFileSync } from 'node:child_process';
          import { dirname } from 'node:path';
          import { renameSync, symlinkSync } from 'node:fs';
          const [pid, target, escaped] = process.argv.slice(1);
          process.stdout.write('ready\\n');
          const until = Date.now() + 30000; // 仅测试OS同步期限。
          while (Date.now() < until) {
            let files = '';
            try { files = execFileSync('/usr/sbin/lsof', ['-nP', '-p', pid, '-Fn'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }); } catch {}
            if (!files.includes('n' + target + '\\n')) continue;
            const parent = dirname(target);
            renameSync(parent, escaped);
            symlinkSync(escaped, parent, 'dir');
            process.stdout.write('moved\\n');
            process.exit(0);
          }
          process.stderr.write('测试未观察到真实计划FD\\n');
          process.exit(2);
        `;
      probe = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          String(process.pid),
          target,
          escaped,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const child = probe;
      const ready = new Promise<void>((done, reject) => {
        child.stdout?.once("data", () => done());
        child.once("error", reject);
      });
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      const exit = new Promise<number | null>((done, reject) => {
        child.once("exit", done);
        child.once("error", reject);
      });
      await ready;
      const reading = store
        .read(directory, identity, ref, {
          maxBytes,
          signal: new AbortController().signal,
        })
        .then(
          () => ({ status: "returned", message: "" }),
          (error: unknown) => ({
            status: "rejected",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      expect(await exit, "必须由OS确认在途FD后完成父目录替换。").toBe(0);
      expect(output).toContain("moved");
      const result = await reading;
      expect(result.status).toBe("rejected");
      expect(result.message).toMatch(/管理目录|管理路径/u);
    } finally {
      probe?.kill();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000); // 单实例FS/FD竞态期限，不是运行时治理值。
});
