import { describe, expect, it } from "vitest";
import type { BundleFiles } from "./bundle-manifest.js";
import { validateBundleFiles } from "./compat-validator.js";

/**
 * 门禁（安装前兼容性拦截）的边界用例。
 * 目标：每条拦截分支都有断言，且**通过**的判定不被误伤。
 */

const HOST_NODE_MAJOR = 22;

/** 构造一个最小可用的 dsh bundle 文件集合。 */
function dshBundle(overrides: {
  pkg?: Record<string, unknown>;
  patch?: string;
  entry?: string;
  extraFiles?: BundleFiles;
}): BundleFiles {
  const pkg = {
    name: "dsh-demo-plugin",
    version: "1.0.0",
    type: "module",
    main: "index.js",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
    ...overrides.pkg,
  };
  return {
    "package.json": JSON.stringify(pkg),
    "cordis.patch.yml":
      overrides.patch ??
      "- insert:\n    - id: demo\n      name: dsh-demo-plugin\n",
    "index.js":
      overrides.entry ??
      "export const name = 'demo'\nexport function apply(ctx) {}\n",
    ...overrides.extraFiles,
  };
}

function validate(
  files: BundleFiles,
  options: { allowLifecycleScripts?: boolean } = {},
) {
  return validateBundleFiles(files, {
    hostNodeMajor: HOST_NODE_MAJOR,
    allowLifecycleScripts: options.allowLifecycleScripts ?? false,
    fallbackName: "demo",
  });
}

function codes(report: ReturnType<typeof validate>): string[] {
  return report.issues.map((item) => item.code);
}

describe("compat-validator：通过路径", () => {
  it("纯工具插件（只依赖 tools）通过", () => {
    const report = validate(
      dshBundle({
        entry: [
          "export const name = 'demo'",
          "export const inject = ['tools']",
          "export function apply(ctx) {",
          "  ctx.effect(() => ctx.tools.register({",
          "    name: 'demo_echo',",
          "    description: 'echo',",
          "    parameters: { type: 'object', properties: {} },",
          "    execute: async () => ({ ok: true }),",
          "  }))",
          "}",
        ].join("\n"),
      }),
    );
    expect(report.compatible).toBe(true);
    expect(report.supportedCapabilities).toEqual(["tools"]);
    expect(report.unsupportedCapabilities).toEqual([]);
    expect(report.issues.filter((i) => i.severity === "blocker")).toEqual([]);
  });

  it("本项目格式（loomic.bundle）同样通过", () => {
    const report = validate({
      "package.json": JSON.stringify({
        name: "@kenfutwork/demo",
        version: "0.1.0",
        main: "index.js",
        kenfutwork: { bundle: { patch: "./cordis.patch.yml" } },
      }),
      "cordis.patch.yml":
        "- insert:\n    - id: demo\n      name: '@kenfutwork/demo'\n",
      "index.js":
        "export const inject = ['tools']\nexport function apply(ctx) {}\n",
    });
    expect(report.compatible).toBe(true);
    expect(report.format).toBe("kenfutwork");
  });

  it("engines 高于宿主仅告警，不拦截", () => {
    const report = validate(
      dshBundle({
        pkg: { engines: { node: ">=99" } },
        entry:
          "export const inject = ['tools']\nexport function apply(ctx) {}\n",
      }),
    );
    expect(report.compatible).toBe(true);
    expect(codes(report)).toContain("engines_incompatible");
  });

  it("空 patch（不贡献任何行）仍可解析", () => {
    const report = validate(
      dshBundle({
        patch: "",
        entry:
          "export const inject = ['tools']\nexport function apply(ctx) {}\n",
      }),
    );
    expect(report.compatible).toBe(true);
  });
});

describe("compat-validator：能力面拦截", () => {
  it("注入未提供的能力（ctx.llm）被拦截", () => {
    const report = validate(
      dshBundle({
        entry: "export const inject = ['llm']\nexport function apply(ctx) {}\n",
      }),
    );
    expect(report.compatible).toBe(false);
    expect(codes(report)).toContain("capability_unsupported");
    expect(report.unsupportedCapabilities).toEqual(["llm"]);
  });

  it("通过 ctx.<member> 访问未提供的能力同样被拦截", () => {
    const report = validate(
      dshBundle({
        entry: "export function apply(ctx) { ctx.fs.readFile('/tmp') }\n",
      }),
    );
    expect(report.compatible).toBe(false);
    expect(report.unsupportedCapabilities).toEqual(["fs"]);
  });

  it("未识别的能力名按拒绝处理（不静默降级）", () => {
    const report = validate(
      dshBundle({
        entry:
          "export const inject = ['telepathy']\nexport function apply(ctx) {}\n",
      }),
    );
    expect(report.compatible).toBe(false);
    expect(report.issues.some((i) => i.detail?.includes("telepathy"))).toBe(
      true,
    );
  });

  it("混合能力：支持项与不支持项分组正确", () => {
    const report = validate(
      dshBundle({
        entry:
          "export const inject = ['tools', 'settings', 'sessions']\nexport function apply(ctx) {}\n",
      }),
    );
    expect(report.compatible).toBe(false);
    expect(report.supportedCapabilities).toEqual(["tools"]);
    expect(report.unsupportedCapabilities).toEqual(["settings", "sessions"]);
  });

  it("未声明任何能力：放行但告警", () => {
    const report = validate(
      dshBundle({ entry: "export function apply() { console.log('hi') }\n" }),
    );
    expect(report.compatible).toBe(true);
    expect(codes(report)).toContain("capability_undeclared");
  });

  it("动态属性访问无法判定，拦截", () => {
    const report = validate(
      dshBundle({
        entry: "export function apply(ctx) { const k = 'tools'; ctx[k] }\n",
      }),
    );
    expect(report.compatible).toBe(false);
    expect(codes(report)).toContain("dynamic_context_access");
  });

  it("直连 child_process 拦截", () => {
    const report = validate(
      dshBundle({
        entry:
          "import { exec } from 'node:child_process'\nexport const inject = ['tools']\nexport function apply(ctx) {}\n",
      }),
    );
    expect(report.compatible).toBe(false);
    expect(codes(report)).toContain("unsafe_module_require");
  });

  it("框架方法（effect/on/inject）不算能力占用", () => {
    const report = validate(
      dshBundle({
        entry: [
          "export function apply(ctx) {",
          "  ctx.effect(() => () => {})",
          "  ctx.on('agent/pre-step', async (p, next) => next(p))",
          "  ctx.inject(['tools'], () => {})",
          "}",
        ].join("\n"),
      }),
    );
    // 仅 ctx.inject(['tools']) 贡献 tools，被支持；已映射事件不拦截
    expect(report.compatible).toBe(true);
    expect(report.requiredCapabilities).toEqual(["tools"]);
  });

  it("订阅已映射事件（agent/pre-step）不拦截", () => {
    const report = validate(
      dshBundle({
        entry: [
          "export const inject = ['tools']",
          "export function apply(ctx) {",
          "  ctx.on('agent/pre-step', async (payload, next) => next(payload))",
          "}",
        ].join("\n"),
      }),
    );
    expect(report.compatible).toBe(true);
  });

  it("订阅未派发事件（fs/changed）被拦截", () => {
    const report = validate(
      dshBundle({
        entry: [
          "export const inject = ['tools']",
          "export function apply(ctx) {",
          "  ctx.on('fs/changed', () => {})",
          "}",
        ].join("\n"),
      }),
    );
    expect(report.compatible).toBe(false);
    expect(codes(report)).toContain("event_unsupported");
  });
});

describe("compat-validator：宿主形态拦截", () => {
  it("依赖 dsh 内置运行时被拦截", () => {
    const report = validate(
      dshBundle({
        pkg: { peerDependencies: { "@deepseek-ai/dsh-tools": "^1.0.0" } },
        entry:
          "export const inject = ['tools']\nexport function apply(ctx) {}\n",
      }),
    );
    expect(report.compatible).toBe(false);
    expect(codes(report)).toContain("requires_dsh_runtime");
  });

  it("携带 dsh web 客户端 UI 被拦截", () => {
    const report = validate(
      dshBundle({
        pkg: {
          dsh: {
            bundle: { patch: "./cordis.patch.yml" },
            client: { inject: ["@deepseek-ai/dsh-client-runtime"] },
          },
        },
        entry:
          "export const inject = ['tools']\nexport function apply(ctx) {}\n",
      }),
    );
    expect(report.compatible).toBe(false);
    expect(codes(report)).toContain("requires_dsh_client");
  });

  it("原生构建被拦截", () => {
    const report = validate(
      dshBundle({
        entry:
          "export const inject = ['tools']\nexport function apply(ctx) {}\n",
        extraFiles: { "binding.gyp": "{}" },
      }),
    );
    expect(report.compatible).toBe(false);
    expect(codes(report)).toContain("native_build_required");
  });

  it("生命周期脚本默认拒绝，显式授权后放行为告警", () => {
    const files = dshBundle({
      pkg: { scripts: { postinstall: "node build.js" } },
      entry: "export const inject = ['tools']\nexport function apply(ctx) {}\n",
    });
    const denied = validate(files);
    expect(denied.compatible).toBe(false);
    expect(codes(denied)).toContain("lifecycle_script_present");

    const allowed = validate(files, { allowLifecycleScripts: true });
    expect(allowed.compatible).toBe(true);
    expect(
      allowed.issues.find((i) => i.code === "lifecycle_script_present")
        ?.severity,
    ).toBe("warning");
  });
});

describe("compat-validator：清单与 patch 解析失败", () => {
  it("缺 package.json", () => {
    const report = validate({ "index.js": "export function apply() {}" });
    expect(report.compatible).toBe(false);
    expect(codes(report)).toEqual(["manifest_missing"]);
  });

  it("package.json 非法 JSON", () => {
    const report = validate({ "package.json": "{ not json" });
    expect(report.compatible).toBe(false);
    expect(codes(report)).toEqual(["manifest_invalid"]);
  });

  it("缺少 name", () => {
    const report = validate({
      "package.json": JSON.stringify({
        version: "1.0.0",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }),
      "cordis.patch.yml": "",
    });
    expect(report.compatible).toBe(false);
    expect(codes(report)).toEqual(["manifest_invalid"]);
  });

  it("只有 profile 声明、没有 bundle 声明：不是插件", () => {
    const report = validate(
      dshBundle({
        pkg: {
          dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
        },
      }),
    );
    expect(report.compatible).toBe(false);
    expect(codes(report)).toEqual(["bundle_declaration_missing"]);
  });

  it("声明的 patch 文件不存在", () => {
    const files = dshBundle({});
    delete files["cordis.patch.yml"];
    const report = validate(files);
    expect(report.compatible).toBe(false);
    expect(codes(report)).toEqual(["manifest_invalid"]);
  });

  it("patch 含 !!js 表达式：单独归因，不是笼统 YAML 错误", () => {
    const report = validate(
      dshBundle({
        patch: "- id: x\n  name: y\n  config:\n    port: !!js ctx.foo ?? 1\n",
        entry:
          "export const inject = ['tools']\nexport function apply(ctx) {}\n",
      }),
    );
    expect(report.compatible).toBe(false);
    expect(codes(report)).toEqual(["config_expression_unsupported"]);
  });

  it("patch 顶层不是数组", () => {
    const report = validate(
      dshBundle({
        patch: "id: x\nname: y\n",
        entry:
          "export const inject = ['tools']\nexport function apply(ctx) {}\n",
      }),
    );
    expect(report.compatible).toBe(false);
    expect(codes(report)).toEqual(["patch_invalid"]);
  });

  it("insert 行缺 name（插入必须指定模块）", () => {
    const report = validate(
      dshBundle({
        patch: "- insert:\n    - id: demo\n",
        entry:
          "export const inject = ['tools']\nexport function apply(ctx) {}\n",
      }),
    );
    expect(report.compatible).toBe(false);
    expect(codes(report)).toEqual(["patch_invalid"]);
  });

  // 回归：真实 dsh 插件（yujunzhixue/dsh-purge）用「只有 id + config」的覆盖行，
  // 早期解析器强制要求 name，把合法 patch 误判为非法。
  it("覆盖行只有 id（无 name）是合法的", () => {
    const report = validate(
      dshBundle({
        patch: [
          "- id: system-prompt",
          "  config:",
          "    includeHarnessIdentity: false",
          "- insert:",
          "    - id: demo",
          "      name: dsh-demo-plugin",
          "",
        ].join("\n"),
        entry:
          "export const inject = ['tools']\nexport function apply(ctx) {}\n",
      }),
    );
    expect(report.compatible).toBe(true);
  });

  it("覆盖行可带 name（替换该行模块）", () => {
    const report = validate(
      dshBundle({
        patch:
          "- id: modules\n  name: '@deepseek-ai/dsh-client-modules'\n  inject: [webServer]\n",
        entry:
          "export const inject = ['tools']\nexport function apply(ctx) {}\n",
      }),
    );
    // 覆盖行的 inject（webServer）也计入所需能力 → 未识别 → 拦截
    expect(report.compatible).toBe(false);
    expect(report.issues.some((i) => i.detail?.includes("webServer"))).toBe(
      true,
    );
  });

  it("覆盖行与插入行混排时两类都解析出来", () => {
    const report = validate(
      dshBundle({
        patch: [
          "- id: system-prompt",
          "  config:",
          "    personaPrefix: hi",
          "- insert:",
          "    - id: demo",
          "      name: dsh-demo-plugin",
          "      inject: [tools]",
          "",
        ].join("\n"),
        entry: "export function apply(ctx) { ctx.effect(() => () => {}) }\n",
      }),
    );
    expect(report.compatible).toBe(true);
    expect(report.supportedCapabilities).toEqual(["tools"]);
  });

  it("patch 非 YAML 文本", () => {
    const report = validate(
      dshBundle({
        patch: "- insert:\n  - id: [unclosed\n",
        entry:
          "export const inject = ['tools']\nexport function apply(ctx) {}\n",
      }),
    );
    expect(report.compatible).toBe(false);
    expect(["patch_invalid", "manifest_invalid"]).toContain(codes(report)[0]);
  });

  it("报告始终带可展示的理由，且不含 console 输出", () => {
    const report = validate({});
    expect(report.issues[0]?.message.length).toBeGreaterThan(0);
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
