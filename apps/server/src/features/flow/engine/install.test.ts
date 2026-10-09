import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cancelEngineInstall, getEngineInstallSnapshot, stopEngineStack } from "./install.js";

/**
 * 引擎栈停止/卸载（FORM-11 生命周期）：
 *  - 默认 `down` 保数据卷；`deleteData` 才 `--volumes`（§9.1③ 显式选择才动数据）；
 *  - 失败原样给可读原因（退出码 + stderr 首行），不假装停止成功；
 *  - 取消安装是非安装态的幂等 no-op。
 */
function fakeRun(result: { code: number; stdout?: string; stderr?: string }) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  return {
    calls,
    run: async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return {
        code: result.code,
        stdout: Buffer.from(result.stdout ?? ""),
        stderr: Buffer.from(result.stderr ?? ""),
      };
    },
  };
}

function options() {
  const dataDir = mkdtempSync(join(tmpdir(), "flow-engine-stop-"));
  return { dataDir, composeFile: join(dataDir, "docker-compose.dify.yml") };
}

describe("引擎栈停止", () => {
  it("默认保留数据卷；deleteData 才追加 --volumes", async () => {
    const first = fakeRun({ code: 0 });
    const kept = await stopEngineStack(options(), { run: first.run });
    expect(kept.ok).toBe(true);
    expect(getEngineInstallSnapshot().state).toBe("idle");
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]?.file).toBe("docker");
    const keptArgs = first.calls[0]?.args ?? [];
    expect(keptArgs).toContain("down");
    expect(keptArgs).toContain("dify");
    expect(keptArgs).toContain("--profile");
    expect(keptArgs).not.toContain("--volumes");

    const second = fakeRun({ code: 0 });
    const wiped = await stopEngineStack(
      { ...options(), deleteData: true },
      { run: second.run },
    );
    expect(wiped.ok).toBe(true);
    expect(second.calls[0]?.args).toContain("--volumes");
  });

  it("生成的 env 文件随数据目录走（down 与 up 同一份密钥口径）", async () => {
    const run = fakeRun({ code: 0 });
    const target = options();
    await stopEngineStack(target, { run: run.run });
    const envFile = join(target.dataDir, "dify-stack.env");
    expect(run.calls[0]?.args).toContain(envFile);
    expect(readFileSync(envFile, "utf8")).toContain("DIFY_ADMIN_API_KEY=");
  });

  it("down 失败原样给原因（退出码 + stderr 首行）", async () => {
    const run = fakeRun({ code: 1, stderr: "no such project\n其余噪音" });
    const result = await stopEngineStack(options(), { run: run.run });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("退出码 1");
    expect(result.error).toContain("no such project");
  });

  it("取消安装：非安装态是幂等 no-op（进行中杀子进程的路径由真机启停覆盖）", () => {
    expect(cancelEngineInstall().state).toBe("idle");
    expect(getEngineInstallSnapshot().state).toBe("idle");
  });
});
