import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    await expect(
      service.search({ query: "x", path: "D:/work/project" }),
    ).rejects.toBeInstanceOf(KnowledgeServiceError);
    enabled = true;
    await expect(
      service.search({ query: "x", path: "D:/work/project" }),
    ).resolves.toHaveProperty("results", expect.any(Array));
  });

  it("语义检索自动初始化并归一化证据；key 从不出现在 argv", async () => {
    const { service, calls } = harness(defaultHandler);
    const result = await service.search({
      query: "重试逻辑在哪",
      maxResults: 3,
      path: "D:/work/project",
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
    await expect(
      service.search({ query: "x", path: "D:/work/project" }),
    ).rejects.toMatchObject({
      code: "service_unavailable",
    });
    await expect(
      service.search({ query: "x", path: "D:/work/project" }),
    ).resolves.toHaveProperty("scope");
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
    await expect(
      service.search({ query: "x", path: "D:/work/project" }),
    ).rejects.toMatchObject({
      code: "service_unavailable",
      message: expect.stringContaining("参数错误"),
    });
  });

  it("平台不支持时即使已安装也 fail loud", async () => {
    const { service } = harness(defaultHandler, { platform: "linux" });
    await expect(
      service.search({ query: "x", path: "D:/work/project" }),
    ).rejects.toMatchObject({
      code: "service_unavailable",
    });
    const status = await service.status();
    expect(status.cli).toBe("unsupported_platform");
    expect(status.active).toBe(false);
  });
});

describe("SagCliProvider（M3：read / 墓碑 / 本地匹配档）", () => {
  it("用户移除根后 ensureRoot 不自动重加；显式 addRoot 清除墓碑", async () => {
    const { service, calls } = harness(defaultHandler);
    await service.ensureRoot("D:/work/project");
    await service.removeRoot("D:/work/project");
    const rejected = await service.ensureRoot("D:/work/project");
    expect(rejected.action).toBe("rejected");
    expect(rejected.reason).toContain("移除");
    // 墓碑生效后 check 不再发起（不碰 CLI）
    const checksAfterRemove = calls.filter((call) => call.args[0] === "check");
    await service.ensureRoot("D:/work/project");
    expect(calls.filter((call) => call.args[0] === "check").length).toBe(
      checksAfterRemove.length,
    );

    await service.addRoot({ path: "D:/work/project" });
    const afterExplicitAdd = await service.ensureRoot("D:/work/project");
    expect(afterExplicitAdd.action).toBe("already-indexed");
  });

  it("removeRoot 返回 \\\\?\\ 长路径前缀时墓碑仍命中普通路径（实采 bug 回归）", async () => {
    const { service } = harness((args) => {
      if (args[0] === "config") return ok(configured);
      if (args[0] === "list") return ok("[]");
      if (args[0] === "remove")
        return ok(JSON.stringify({ path: "\\\\?\\D:\\work\\project" }));
      if (args[0] === "check")
        return ok(
          JSON.stringify({
            path: "D:/work/project",
            coverage: "none",
            index_ready: false,
            enabled: true,
            indexed_files: 0,
            roots: [],
          }),
        );
      if (args[0] === "add")
        return ok(
          JSON.stringify({
            path: "D:/work/project",
            index_status: "ready",
            cli_authorized: true,
          }),
        );
      return ok(searchOutput);
    });
    await service.removeRoot("D:/work/project");
    const result = await service.ensureRoot("D:/work/project");
    expect(result.action).toBe("rejected");
  });

  it("本地匹配档走 -F 位置参数并解析 MatchOutput，不要求 Jev 凭据", async () => {
    const matchOutput = JSON.stringify({
      protocol_version: 2,
      scope: "D:/work/project",
      results: [
        {
          path: "src/client.ts",
          absolute_path: "D:/work/project/src/client.ts",
          start_line: 142,
          end_line: 142,
          matched_lines: [142],
          content: "if (status === 499) retry();",
        },
      ],
      files: [
        {
          path: "src/client.ts",
          absolute_path: "D:/work/project/src/client.ts",
          count: 1,
        },
      ],
      matched: true,
      truncated: false,
    });
    const { service, calls } = harness((args) =>
      args[0] === "config" ? ok(configured) : ok(matchOutput),
    );
    const result = await service.search({
      query: "499",
      path: "D:/work/project",
      localMatch: true,
    });
    expect(result.results[0]?.matchedLines).toEqual([142]);
    const call = calls.find((item) => item.args[0] === "-F");
    // 0.1.8 帮助实测：-F/-E 需显式 -c 才返回正文。
    expect(call?.args).toEqual([
      "-F",
      "499",
      "-c",
      "D:/work/project",
      "--json",
    ]);
    // 显式降级档不初始化 Jev 凭据（config 只可能来自 provider 内其他路径）
    expect(calls.some((item) => item.args[0] === "config")).toBe(false);
  });

  it("语义检索参数含 -c 取正文、-m 默认 5、超时透传给 runner", async () => {
    const { service, calls } = harness((args) =>
      args[0] === "config" ? ok(configured) : ok(searchOutput),
    );
    let receivedTimeout: number | undefined;
    // 重新包一层 runner 以观察 timeoutMs
    const serviceWithTimeout = createSagCliProvider({
      runner: async (run) => {
        receivedTimeout = run.timeoutMs;
        return run.args[0] === "config" ? ok(configured) : ok(searchOutput);
      },
      tryGetPlugins: () => fakePlugins(true),
      readJevCredential: async () => "jev-key-123",
      platform: "win32",
      arch: "x64",
      indexExtensions: ["md", "ts"],
    });
    await serviceWithTimeout.search({
      query: "重试",
      path: "D:/work/project",
      timeoutMs: 12_000,
    });
    expect(receivedTimeout).toBe(12_000);
    await service.search({ query: "重试", path: "D:/work/project" });
    const search = calls.find(
      (call) => call.args[0] === "重试" && call.args.includes("--json"),
    );
    expect(search?.args).toContain("-c");
    expect(search?.args.slice(search.args.indexOf("-m"))).toEqual(
      expect.arrayContaining(["-m", "5"]),
    );
  });

  it("read 在根内按行切片、越界钳回、字节预算截断", async () => {
    const root = await mkdtemp(join(tmpdir(), "kfw-kb-"));
    const file = join(root, "note.md");
    await writeFile(file, ["第一行", "第二行", "第三行", "第四行"].join("\n"));
    const { service } = harness((args) => {
      if (args[0] === "config") return ok(configured);
      if (args[0] === "list")
        return ok(
          JSON.stringify([
            { path: root, name: "kb", status: "ready", count: 1, error: null },
          ]),
        );
      return ok(searchOutput);
    });
    const slice = await service.read({
      path: file,
      startLine: 2,
      endLine: 3,
    });
    expect(slice.content).toBe("第二行\n第三行");
    expect(slice.truncated).toBe(false);

    const clamped = await service.read({
      path: file,
      startLine: 3,
      endLine: 99,
    });
    expect(clamped.content).toBe("第三行\n第四行");

    // 治理护栏下限 1KiB：用超过 1KiB 的文件验证字节预算截断
    const big = join(root, "big.md");
    await writeFile(big, "x".repeat(5000));
    const truncated = await service.read({ path: big, maxBytes: 1024 });
    expect(truncated.truncated).toBe(true);
    expect(truncated.content.length).toBe(1024);
  });

  it("read 拒绝根外路径、相对路径与符号链接逃逸", async () => {
    const root = await mkdtemp(join(tmpdir(), "kfw-kb-"));
    const outside = await mkdtemp(join(tmpdir(), "kfw-out-"));
    const inside = join(root, "inside.md");
    const secret = join(outside, "secret.md");
    await writeFile(inside, "ok");
    await writeFile(secret, "secret");
    const { service } = harness((args) => {
      if (args[0] === "config") return ok(configured);
      if (args[0] === "list")
        return ok(
          JSON.stringify([
            { path: root, name: "kb", status: "ready", count: 1, error: null },
          ]),
        );
      return ok(searchOutput);
    });
    await expect(service.read({ path: secret })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(service.read({ path: "inside.md" })).rejects.toMatchObject({
      code: "invalid_input",
    });

    const link = join(root, "escape.md");
    let linked = false;
    try {
      await symlink(secret, link, "file");
      linked = true;
    } catch {
      // Windows 未开开发者模式时无符号链接权限：跳过逃逸断言。
    }
    if (linked) {
      await expect(service.read({ path: link })).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
  });

  it("无 path 检索：遍历全部已注册根并合并去重、截到预算", async () => {
    const roots = ["D:/kb/one", "D:/kb/two"];
    const searchCalls: string[] = [];
    const { service } = harness((args) => {
      if (args[0] === "config") return ok(configured);
      if (args[0] === "list")
        return ok(
          JSON.stringify(
            roots.map((path) => ({
              path,
              name: path.split("/").pop(),
              status: "ready",
              count: 1,
              error: null,
            })),
          ),
        );
      const pathArg = args.includes("--path")
        ? args[args.indexOf("--path") + 1]
        : (args[3] ?? "");
      searchCalls.push(String(pathArg));
      const absolute = `${pathArg}/a.md`;
      return ok(
        JSON.stringify({
          protocol_version: 2,
          scope: pathArg,
          results: [
            {
              path: "a.md",
              absolute_path: absolute,
              start_line: 10,
              end_line: 13,
              content: "x",
            },
            {
              path: "a.md",
              absolute_path: absolute,
              start_line: 10,
              end_line: 13,
              content: "dup",
            },
          ],
          truncated: false,
        }),
      );
    });
    const result = await service.search({ query: "负责人", maxResults: 5 });
    expect(searchCalls).toEqual(roots);
    // 两根各返回同一位置（不同绝对路径）→ 2 条；重复项已去重
    expect(result.results).toHaveLength(2);
    expect(result.scope).toContain("D:/kb/one");
    expect(result.scope).toContain("D:/kb/two");
  });

  it("无 path 且没有已注册根：返回空结果，不报错", async () => {
    const { service } = harness(defaultHandler); // list 返回 []
    const result = await service.search({ query: "负责人" });
    expect(result).toEqual({ scope: "", results: [], truncated: false });
  });

  it("根集合修订号随 add/remove/ensure(added) 单调递增", async () => {
    const { service } = harness((args) => {
      if (args[0] === "config") return ok(configured);
      if (args[0] === "list") return ok("[]");
      if (args[0] === "check")
        return ok(
          JSON.stringify({
            path: "D:/work/project",
            coverage: "none",
            index_ready: false,
            enabled: true,
            indexed_files: 0,
            roots: [],
          }),
        );
      if (args[0] === "add")
        return ok(
          JSON.stringify({
            path: "D:/work/project",
            index_status: "ready",
            cli_authorized: true,
          }),
        );
      if (args[0] === "remove")
        return ok(JSON.stringify({ path: "D:/work/project" }));
      return ok(searchOutput);
    });
    const before = service.rootsRevision();
    await service.addRoot({ path: "D:/work/project" });
    expect(service.rootsRevision()).toBe(before + 1);
    await service.removeRoot("D:/work/project");
    expect(service.rootsRevision()).toBe(before + 2);
    const ensure = await service.ensureRoot("D:/other");
    // D:/other 走 defaultHandler 的 check=none → add；但 add handler 返回固定路径
    expect(ensure.action).toBe("added");
    expect(service.rootsRevision()).toBe(before + 3);
  });
});
