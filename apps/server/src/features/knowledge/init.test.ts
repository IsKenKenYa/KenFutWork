import { homedir } from "node:os";
import { join, parse } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ensureKnowledgeRoot,
  initializeKnowledge,
  isPersonalDirectory,
  type KnowledgeInitOptions,
} from "./init.js";
import {
  createProcessSagRunner,
  redactSecrets,
  type SagCommandResult,
  type SagRunner,
} from "./sag-cli-runner.js";

const ok = (stdout: string): SagCommandResult => ({
  code: 0,
  stdout,
  stderr: "",
});

function runnerFrom(
  handler: (args: readonly string[], stdin?: string) => SagCommandResult,
): SagRunner {
  return async (options) => handler(options.args, options.stdin);
}

function initOptions(
  runner: SagRunner,
  credential: string | null = "jev-key-123",
  platform: NodeJS.Platform = "win32",
): KnowledgeInitOptions {
  return {
    runner,
    readJevCredential: vi.fn(async () => credential),
    platform,
    arch: "x64",
    indexExtensions: ["md", "ts", "tsx"],
  };
}

const configured = JSON.stringify({
  url: "https://api.302ai.cn/typesafeai/v1",
  model: "jev-latest",
  models: [],
  has_key: true,
  auth_mode: "bearer",
});
const unconfigured = JSON.stringify({
  url: "https://api.302ai.cn/typesafeai/v1",
  model: "jev-latest",
  models: [],
  has_key: false,
  auth_mode: "bearer",
});

describe("M2 初始化：凭据 stdin 注入（KB-1）", () => {
  it("已配置则复用，绝不读取或覆盖宿主凭据", async () => {
    const options = initOptions(
      runnerFrom((args) => {
        expect(args).toEqual(["config"]);
        return ok(configured);
      }),
    );
    const result = await initializeKnowledge(options);
    expect(result).toEqual({
      ok: true,
      credential: "reused",
      cli: "available",
      reason: null,
    });
    expect(options.readJevCredential).not.toHaveBeenCalled();
  });

  it("未配置时经 stdin 注入，key 不进 argv、不回显", async () => {
    const seen: Array<{ args: readonly string[]; stdin?: string | undefined }> =
      [];
    const options = initOptions(
      runnerFrom((args, stdin) => {
        seen.push({ args, stdin });
        return args[0] === "config" && args.length === 1
          ? ok(unconfigured)
          : ok(configured);
      }),
      "jev-key-123",
    );
    const result = await initializeKnowledge(options);
    expect(result.ok).toBe(true);
    expect(result.credential).toBe("injected");

    const inject = seen[1];
    if (!inject) throw new Error("缺少凭据注入调用");
    expect(inject.args).toEqual(["config", "--auth", "bearer", "--key-stdin"]);
    expect(inject.args.join(" ")).not.toContain("jev-key-123");
    expect(inject.stdin).toBe("jev-key-123");
    expect(JSON.stringify(result)).not.toContain("jev-key-123");
  });

  it("宿主没有 TypeSafe 实例时不擅自创建，给出明确引导", async () => {
    const options = initOptions(
      runnerFrom(() => ok(unconfigured)),
      null,
    );
    const result = await initializeKnowledge(options);
    expect(result.ok).toBe(false);
    expect(result.credential).toBe("missing");
    expect(result.reason).toContain("尚未配置 Jev 检索凭据");
  });

  it("config 输出非 JSON / 注入失败都如实上报，不静默", async () => {
    const broken = initOptions(runnerFrom(() => ok("首次配置引导文本")));
    expect((await initializeKnowledge(broken)).reason).toContain(
      "不是合法 JSON",
    );

    const failed = initOptions(
      runnerFrom((args) =>
        args.length === 1
          ? ok(unconfigured)
          : { code: 1, stdout: "", stderr: "写入失败" },
      ),
    );
    const result = await initializeKnowledge(failed);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("写入失败");
  });

  it("平台无原生二进制时直接 fail loud，不碰 CLI", async () => {
    const runner = vi.fn(runnerFrom(() => ok(configured)));
    const result = await initializeKnowledge(initOptions(runner, "k", "linux"));
    expect(result.cli).toBe("unsupported_platform");
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("M2 工作区根自动注册（KB-3）", () => {
  const project = join(parse(process.cwd()).root, "work", "kenfutwork");

  it("个人目录 / 磁盘根 / home 祖先一律拒绝自动注册", () => {
    expect(isPersonalDirectory(parse(process.cwd()).root)).toBe(true);
    expect(isPersonalDirectory(homedir())).toBe(true);
    expect(isPersonalDirectory(join(homedir(), "Downloads"))).toBe(true);
    expect(
      isPersonalDirectory(
        join(parse(process.cwd()).root, "work", "kenfutwork"),
      ),
    ).toBe(false);
  });

  it("已覆盖的根只回报，不改 --types（保护用户桌面端设置）", async () => {
    const addCalls: string[] = [];
    const options = initOptions(
      runnerFrom((args) => {
        if (args[0] === "add") addCalls.push(args.join(" "));
        return ok(
          JSON.stringify({
            path: project,
            coverage: "included",
            index_ready: true,
            enabled: true,
            indexed_files: 10,
            roots: [],
            extensions: ["md"],
          }),
        );
      }),
    );
    const result = await ensureKnowledgeRoot(options, project);
    expect(result.action).toBe("already-indexed");
    expect(addCalls).toHaveLength(0);
  });

  it("新根用 --types 显式开启代码扩展名", async () => {
    const calls: Array<readonly string[]> = [];
    const options = initOptions(
      runnerFrom((args) => {
        calls.push(args);
        if (args[0] === "check") {
          return ok(
            JSON.stringify({
              path: project,
              coverage: "none",
              index_ready: false,
              enabled: true,
              indexed_files: 0,
              roots: [],
            }),
          );
        }
        return ok(
          JSON.stringify({
            path: project,
            index_status: "ready",
            cli_authorized: true,
          }),
        );
      }),
    );
    const result = await ensureKnowledgeRoot(options, project);
    expect(result.action).toBe("added");
    const add = calls.find((args) => args[0] === "add");
    if (!add) throw new Error("缺少 add 调用");
    expect(add).toContain("--types");
    expect(add.join(",")).toContain("ts");
  });

  it("部分覆盖 / 已排除 / check 参数错误都不自动改写", async () => {
    for (const coverage of ["partial", "excluded"]) {
      const options = initOptions(
        runnerFrom(() =>
          ok(
            JSON.stringify({
              path: project,
              coverage,
              index_ready: false,
              enabled: true,
              indexed_files: 0,
              roots: [],
            }),
          ),
        ),
      );
      expect((await ensureKnowledgeRoot(options, project)).action).toBe(
        "deferred",
      );
    }
    const failing = initOptions(
      runnerFrom(() => ({
        code: 2,
        stdout: "",
        stderr: "参数错误",
      })),
    );
    const result = await ensureKnowledgeRoot(failing, project);
    expect(result.action).toBe("deferred");
    expect(result.reason).toContain("参数错误");
  });

  it("相对路径直接拒绝", async () => {
    const options = initOptions(runnerFrom(() => ok("{}")));
    expect((await ensureKnowledgeRoot(options, "./src")).action).toBe(
      "rejected",
    );
  });
});

describe("CLI 执行器的凭据护栏", () => {
  it("redactSecrets 抹掉 stdout/stderr 里出现的凭据", () => {
    expect(redactSecrets("token=jev-key-123 failed", ["jev-key-123"])).toBe(
      "token=[已隐藏] failed",
    );
    expect(redactSecrets("nothing", [""])).toBe("nothing");
  });

  it("凭据出现在 argv 时拒绝执行（不真的起进程）", async () => {
    const runner = createProcessSagRunner({ binary: "sag-not-installed" });
    await expect(
      runner({
        args: ["config", "--key", "jev-key-123"],
        stdin: "jev-key-123",
      }),
    ).rejects.toThrow(/凭据出现在 argv/);
  });
});
