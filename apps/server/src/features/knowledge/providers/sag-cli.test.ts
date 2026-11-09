import { describe, expect, it } from "vitest";

import type { SagCommandResult, SagRunner } from "../sag-cli-runner.js";
import type { PluginsServiceLike } from "../service.js";
import { KNOWLEDGE_BUNDLE_ID, KnowledgeServiceError } from "../types.js";
import { createSagCliProvider } from "./sag-cli.js";

interface Call {
  args: readonly string[];
  stdin?: string;
}

function fakePlugins(installed: boolean, enabled = true): PluginsServiceLike {
  return {
    async list() {
      return installed
        ? [
            {
              id: KNOWLEDGE_BUNDLE_ID,
              name: KNOWLEDGE_BUNDLE_ID,
              installed,
              enabled,
            },
          ]
        : [];
    },
  };
}

const configured = JSON.stringify({
  url: "https://api.302ai.cn/typesafeai/v1",
  model: "jev-latest",
  models: [],
  has_key: true,
  auth_mode: "bearer",
});

const searchOutput = JSON.stringify({
  protocol_version: 2,
  scope: "D:/work/project",
  results: [
    {
      heading: "重试逻辑",
      path: "src/client.ts",
      absolute_path: "D:/work/project/src/client.ts",
      start_line: 142,
      end_line: 158,
      content: "if (status === 499) retry();",
    },
  ],
  truncated: false,
});

function harness(
  handler: (args: readonly string[]) => SagCommandResult,
  options: {
    installed?: boolean;
    enabled?: boolean;
    credential?: string | null;
    platform?: NodeJS.Platform;
  } = {},
) {
  const calls: Call[] = [];
  const runner: SagRunner = async (run) => {
    calls.push({ args: run.args, ...(run.stdin ? { stdin: run.stdin } : {}) });
    return handler(run.args);
  };
  const service = createSagCliProvider({
    runner,
    tryGetPlugins: () =>
      fakePlugins(options.installed ?? true, options.enabled ?? true),
    readJevCredential: async () => options.credential ?? "jev-key-123",
    platform: options.platform ?? "win32",
    arch: "x64",
    indexExtensions: ["md", "ts"],
  });
  return { service, calls };
}

const ok = (stdout: string): SagCommandResult => ({
  code: 0,
  stdout,
  stderr: "",
});

function defaultHandler(args: readonly string[]): SagCommandResult {
  if (args[0] === "config" && args.length === 1) return ok(configured);
  if (args[0] === "list") return ok("[]");
  if (args[0] === "check") {
    return ok(
      JSON.stringify({
        path: "D:/work/project",
        coverage: "included",
        index_ready: true,
        enabled: true,
        indexed_files: 3,
        roots: [],
      }),
    );
  }
  if (args[0] === "add") {
    return ok(
      JSON.stringify({
        path: "D:/work/project",
        index_status: "ready",
        cli_authorized: true,
      }),
    );
  }
  if (args[0] === "remove")
    return ok(JSON.stringify({ path: "D:/work/project" }));
  return ok(searchOutput);
}

describe("SagCliProvider（M2）", () => {
  it("未安装时检索 fail closed，且完全不碰 CLI", async () => {
    const { service, calls } = harness(defaultHandler, { installed: false });
    await expect(service.search({ query: "重试逻辑" })).rejects.toMatchObject({
      code: "service_unavailable",
    });
    expect(calls).toHaveLength(0);
  });

  it("停用时不激活；重新启用后下一次调用立即生效（不缓存安装态）", async () => {
    let enabled = false;
    const runner: SagRunner = async (run) =>
      run.args[0] === "config" ? ok(configured) : ok(searchOutput);
    const service = createSagCliProvider({
      runner,
      tryGetPlugins: () => ({
        async list() {
          return [
            {
              id: KNOWLEDGE_BUNDLE_ID,
              name: KNOWLEDGE_BUNDLE_ID,
              installed: true,
              enabled,
            },
          ];
        },
      }),
      readJevCredential: async () => "k",
      platform: "win32",
      arch: "x64",
    });
    await expect(service.search({ query: "x" })).rejects.toBeInstanceOf(
      KnowledgeServiceError,
    );
    enabled = true;
    await expect(service.search({ query: "x" })).resolves.toHaveProperty(
      "results",
      expect.any(Array),
    );
  });

  it("语义检索自动初始化并归一化证据；key 从不出现在 argv", async () => {
    const { service, calls } = harness(defaultHandler);
    const result = await service.search({
      query: "重试逻辑在哪",
      maxResults: 3,
    });
    expect(result.results[0]).toMatchObject({
      path: "src/client.ts",
      absolutePath: "D:/work/project/src/client.ts",
      startLine: 142,
      endLine: 158,
      content: "if (status === 499) retry();",
    });
    expect(result.truncated).toBe(false);
    const search = calls.find((call) => call.args.includes("-m"));
    if (!search) throw new Error("缺少检索调用");
    expect(search.args).toContain("重试逻辑在哪");
    expect(search.args).toContain("3");
    expect(
      calls.every((call) => !call.args.join(" ").includes("jev-key-123")),
    ).toBe(true);
  });

  it("初始化失败不缓存：凭据配好后下一次调用自愈", async () => {
    let configCalls = 0;
    const { service } = harness((args) => {
      if (args[0] === "config" && args.length === 1) {
        configCalls += 1;
        return configCalls === 1 ? ok("引导文本") : ok(configured);
      }
      return ok(searchOutput);
    });
    await expect(service.search({ query: "x" })).rejects.toMatchObject({
      code: "service_unavailable",
    });
    await expect(service.search({ query: "x" })).resolves.toHaveProperty(
      "scope",
    );
    expect(configCalls).toBe(2);
  });

  it("目录命令不要求 Jev 凭据（建库与检索服务解耦）", async () => {
    const { service, calls } = harness(defaultHandler);
    await service.listRoots();
    await service.addRoot({ path: "D:/work/project" });
    await service.removeRoot("D:/work/project");
    expect(calls.some((call) => call.args[0] === "config")).toBe(false);
    const add = calls.find((call) => call.args[0] === "add");
    if (!add) throw new Error("缺少 add 调用");
    expect(add.args).toContain("--types");
    expect(add.args.join(",")).toContain("ts");
  });

  it("ensureRoot 委托给幂等编排，已覆盖时不重复 add", async () => {
    const { service, calls } = harness(defaultHandler);
    const result = await service.ensureRoot("D:/work/project");
    expect(result.action).toBe("already-indexed");
    expect(calls.some((call) => call.args[0] === "add")).toBe(false);
  });

  it("空 query / 超长 query 在发起检索前就被拒", async () => {
    const { service, calls } = harness(defaultHandler);
    await expect(service.search({ query: "   " })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      service.search({ query: "x".repeat(2001) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls.filter((call) => call.args.includes("-m"))).toHaveLength(0);
  });

  it("上游退出码 2 转成显式 service_unavailable，不静默", async () => {
    const { service } = harness((args) =>
      args[0] === "config"
        ? ok(configured)
        : { code: 2, stdout: "", stderr: "参数错误" },
    );
    await expect(service.search({ query: "x" })).rejects.toMatchObject({
      code: "service_unavailable",
      message: expect.stringContaining("参数错误"),
    });
  });

  it("平台不支持时即使已安装也 fail loud", async () => {
    const { service } = harness(defaultHandler, { platform: "linux" });
    await expect(service.search({ query: "x" })).rejects.toMatchObject({
      code: "service_unavailable",
    });
    const status = await service.status();
    expect(status.cli).toBe("unsupported_platform");
    expect(status.active).toBe(false);
  });
});
