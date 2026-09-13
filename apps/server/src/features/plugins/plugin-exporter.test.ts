import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { loadCompatPlugin } from "./compat-context.js";
import { validateBundleFiles } from "./compat-validator.js";
import {
  exportPluginBundle,
  type PluginExportSpec,
  sanitizeToolName,
} from "./plugin-exporter.js";

/**
 * 导出往返测试：这是「双方互通」的核心证据链——
 * 导出的产物必须**通过本项目门禁**、能装回本项目、并真的注册出可调用工具；
 * 同时它的形状必须是 dsh 认的 bundle（`dsh.bundle.patch` + 行 name 指向包名）。
 */

function makeEnv(): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "test-model",
    port: 0,
    version: "test",
    webOrigin: "http://localhost:3000",
  } as ServerEnv;
}

const SPEC: PluginExportSpec = {
  name: "Demo Clock",
  version: "1.2.0",
  description: "演示用时钟插件",
  capabilities: ["tools"],
  tools: [
    {
      name: "clock_now",
      description: "返回当前时间",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "clock.format/timestamp",
      description: "格式化非法字符应被规范化",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
  ],
};

async function writeBundle(
  files: Record<string, string>,
): Promise<{ dir: string; entry: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "loomic-bundle-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(path.dirname(target), { recursive: true }),
    );
    await writeFile(target, content, "utf8");
  }
  return { dir, entry: path.join(dir, "index.js") };
}

function gate(files: Record<string, string>) {
  return validateBundleFiles(files, {
    hostNodeMajor: 22,
    allowLifecycleScripts: false,
    fallbackName: "exported",
  });
}

describe("plugin-exporter：dsh 形状契约", () => {
  it("导出的 package.json 是 dsh 认的 bundle 声明", () => {
    const artifact = exportPluginBundle(SPEC, "dsh");
    const pkg = JSON.parse(artifact.files["package.json"]!) as {
      name: string;
      dsh?: { bundle?: { patch?: string } };
      loomic?: { bundle?: { patch?: string } };
      files?: string[];
      type?: string;
    };
    expect(pkg.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    expect(pkg.loomic?.bundle?.patch).toBe("./cordis.patch.yml");
    expect(pkg.type).toBe("module");
    expect(pkg.files).toContain("index.js");
    expect(artifact.files["cordis.patch.yml"]).toBeDefined();
  });

  it("patch 行的 name 指向包名（dsh 靠 Node 解析该名）", () => {
    const artifact = exportPluginBundle(SPEC, "dsh");
    const pkg = JSON.parse(artifact.files["package.json"]!) as {
      name: string;
    };
    const patch = artifact.files["cordis.patch.yml"]!;
    expect(patch).toContain(`name: ${pkg.name}`);
    expect(patch).toContain("inject: [tools]");
  });
});

describe("plugin-exporter：回灌往返", () => {
  it("导出物通过本项目门禁", () => {
    const report = gate(exportPluginBundle(SPEC, "dsh").files);
    expect(report.compatible).toBe(true);
    expect(report.supportedCapabilities).toEqual(["tools"]);
    expect(report.format).toBe("dsh");
  });

  it("导出物落盘后能被内核装载并注册出可调用工具", async () => {
    const artifact = exportPluginBundle(SPEC, "dsh");
    const { dir, entry } = await writeBundle(artifact.files);
    try {
      const kernel = composePlugins(makeEnv(), []);
      const loaded = await loadCompatPlugin(
        await import(/* @vite-ignore */ pathToFileURL(entry).href),
        {
          tools: kernel.get("tools"),
          subscribe: () => () => {},
          label: artifact.name,
        },
      );

      expect(loaded.pluginName).toBe(SPEC.name);
      expect(loaded.toolNames).toEqual(["clock_now", "clock_format_timestamp"]);

      const result = await kernel
        .get("tools")
        .require("clock_now")
        .execute({}, {});
      expect(String(result)).toContain("尚未实现");
      loaded.dispose();
      expect(kernel.get("tools").get("clock_now")).toBeUndefined();
      kernel.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("双声明的产物两端都能装（format 只影响安装指引）", () => {
    const artifact = exportPluginBundle(SPEC, "loomic");
    const pkg = JSON.parse(artifact.files["package.json"]!) as {
      dsh?: unknown;
      loomic?: unknown;
    };
    // 双声明：dsh 与本项目都能识别同一份文件
    expect(pkg.dsh).toBeDefined();
    expect(pkg.loomic).toBeDefined();
    expect(artifact.format).toBe("loomic");
    expect(artifact.installHint).toContain("插件市场");

    const report = gate(artifact.files);
    expect(report.compatible).toBe(true);
    // 双声明按 dsh 识别（约定主格式）
    expect(report.format).toBe("dsh");
  });

  it("骨架总会经 ctx.tools 注册，故能力声明必含 tools（声明与实现一致）", () => {
    const artifact = exportPluginBundle(
      { ...SPEC, tools: [], capabilities: [] },
      "dsh",
    );
    const patch = artifact.files["cordis.patch.yml"]!;
    expect(patch).toContain("inject: [tools]");
    const indexJs = artifact.files["index.js"]!;
    expect(indexJs).toContain('export const inject = ["tools"]');
  });

  it("导出不会洗白不支持的能力：声明 llm 的产物仍被自己的门禁拦下", () => {
    const report = gate(
      exportPluginBundle({ ...SPEC, capabilities: ["llm"] }, "dsh").files,
    );
    expect(report.compatible).toBe(false);
    expect(report.unsupportedCapabilities).toEqual(["llm"]);
  });

  it("无工具的纯声明插件导出后仍可安装（不因缺工具被拦）", () => {
    const report = gate(
      exportPluginBundle({ ...SPEC, tools: [], capabilities: [] }, "dsh").files,
    );
    expect(report.compatible).toBe(true);
    expect(report.issues.filter((i) => i.severity === "blocker")).toEqual([]);
  });
});

describe("plugin-exporter：工具名与包名规范化", () => {
  it("非法字符替换为下划线", () => {
    expect(sanitizeToolName("clock.format/timestamp")).toBe(
      "clock_format_timestamp",
    );
    expect(sanitizeToolName("a b c")).toBe("a_b_c");
  });

  it("超长名截断并附确定性后缀，不同名不塌缩", () => {
    const long = "x".repeat(200);
    const other = `${long}y`;
    const a = sanitizeToolName(long);
    const b = sanitizeToolName(other);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
    expect(sanitizeToolName(long)).toBe(a);
  });

  it("包名规范化为合法 npm 名", () => {
    const artifact = exportPluginBundle(
      { ...SPEC, name: "  Demo Clock!! " },
      "dsh",
    );
    const pkg = JSON.parse(artifact.files["package.json"]!) as {
      name: string;
    };
    expect(pkg.name).toBe("demo-clock");
  });
});
