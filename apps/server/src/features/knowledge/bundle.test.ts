import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { buildBundleManifest } from "../plugins/bundle-manifest.js";
import { validateBundleFiles } from "../plugins/compat-validator.js";
import { KNOWLEDGE_PANEL_ID } from "./tools.js";
import { KNOWLEDGE_BUNDLE_ID } from "./types.js";

/**
 * 市场 bundle 与宿主门控的一致性回归：
 * - 清单（package.json）必须是可安装且兼容的（无 child_process/node:fs 等能力越界）；
 * - 运行时 `ctx.ui.register` 的面板 id 必须与动态工具同步门控（listUiEntries）匹配；
 * - scope=shared 与 sidebar 槽位是「无论什么模式都在侧栏」的契约落点。
 */

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const PLUGIN_DIR = path.join(REPO_ROOT, "plugins", "knowledge");

async function readFiles(
  dir: string,
  prefix = "",
): Promise<Record<string, string>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(
        files,
        await readFiles(path.join(dir, entry.name), relative),
      );
    } else {
      files[relative] = await readFile(path.join(dir, entry.name), "utf8");
    }
  }
  return files;
}

describe("plugins/knowledge bundle（M4）", () => {
  it("清单可解析：scope=shared、sidebar 槽位、assets 与钉住的面板 id", async () => {
    const files = await readFiles(PLUGIN_DIR);
    const { manifest } = buildBundleManifest(files);
    expect(manifest.name).toBe(KNOWLEDGE_BUNDLE_ID);
    expect(manifest.scope).toBe("shared");
    expect(manifest.assets).toBe(true);
    expect(manifest.title).toBe("知识库");
    expect(manifest.icon).toBe("assets/icon.svg");
    expect(manifest.ui).toEqual([
      expect.objectContaining({
        id: KNOWLEDGE_PANEL_ID,
        slot: "sidebar",
        url: "assets/panel.html",
      }),
    ]);
  });

  it("兼容性门禁通过：无子进程/文件系统等越界能力，入口与资源齐全", async () => {
    const files = await readFiles(PLUGIN_DIR);
    const report = validateBundleFiles(files, {
      hostNodeMajor: 22,
      allowLifecycleScripts: false,
      fallbackName: KNOWLEDGE_BUNDLE_ID,
    });
    expect(
      report.issues.filter((issue) => issue.severity === "blocker"),
    ).toEqual([]);
    expect(report.compatible).toBe(true);
  });

  it("运行时注册的面板与清单同 id（动态工具同步门控依赖它）", async () => {
    const moduleUrl = `${pathToFileURL(path.join(PLUGIN_DIR, "index.js")).href}?v=${Date.now()}`;
    const namespace = (await import(/* @vite-ignore */ moduleUrl)) as {
      name: string;
      inject: string[];
      apply(ctx: {
        ui: { register(entry: Record<string, unknown>): void };
      }): void;
    };
    expect(namespace.name).toBe(KNOWLEDGE_BUNDLE_ID);
    expect(namespace.inject).toContain("ui");
    const registered: Array<Record<string, unknown>> = [];
    namespace.apply({
      ui: { register: (entry) => registered.push(entry) },
    });
    expect(registered).toEqual([
      expect.objectContaining({
        id: KNOWLEDGE_PANEL_ID,
        slot: "sidebar",
        url: "assets/panel.html",
      }),
    ]);
  });

  it("面板只走宿主 /api/knowledge/*，不调用插件私有路由或外部地址", async () => {
    const panel = await readFile(
      path.join(PLUGIN_DIR, "assets", "panel.html"),
      "utf8",
    );
    expect(panel).toContain('credentials: "include"');
    // 云盘式：上传/列表走 library、内容检索走 search、原文走 read；
    // 面板不再有「就绪」状态块（不再请求 status），也不提供设置项，因此不出现 settings 路由。
    expect(panel).not.toContain("/api/knowledge/status");
    expect(panel).toContain("category");
    expect(panel).toContain("/api/knowledge/library");
    expect(panel).toContain("/api/knowledge/search");
    expect(panel).toContain("/api/knowledge/read");
    expect(panel).not.toContain("/api/knowledge/settings");
    expect(panel).not.toContain("/api/plugins/");
    expect(panel).not.toMatch(/https?:\/\//u);
  });
});
