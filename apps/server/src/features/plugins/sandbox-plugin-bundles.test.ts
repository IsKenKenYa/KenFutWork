import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { listSandboxPluginBundles } from "./sandbox-plugin-bundles.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "kfw-plugin-scan-"));
}

function writePackage(
  root: string,
  relativeDir: string,
  manifest: Record<string, unknown>,
): void {
  const dir = join(root, relativeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
}

describe("工作目录里的插件 bundle 扫描（从工作目录安装）", () => {
  it("识别 loomic.bundle 与 dsh.bundle 两种声明，并带出 name/version", () => {
    const root = makeRoot();
    writePackage(root, "my-plugin", {
      name: "my-plugin",
      version: "1.2.3",
      loomic: { bundle: { patch: "loomic.patch.yml" } },
    });
    writePackage(root, "dsh-plugin", {
      name: "dsh-plugin",
      version: "0.4.0",
      dsh: { bundle: { patch: "cordis.patch.yml" } },
    });
    writePackage(root, "not-a-plugin", { name: "plain", version: "1.0.0" });

    const found = listSandboxPluginBundles(root);
    expect(found).toEqual([
      {
        path: "dsh-plugin",
        name: "dsh-plugin",
        version: "0.4.0",
        declaredBy: "dsh",
      },
      {
        path: "my-plugin",
        name: "my-plugin",
        version: "1.2.3",
        declaredBy: "loomic",
      },
    ]);
  });

  it("跳过依赖/构建/隐藏目录，且 bundle 内部不再向下找嵌套 bundle", () => {
    const root = makeRoot();
    writePackage(root, "node_modules/evil", {
      name: "evil",
      dsh: { bundle: {} },
    });
    writePackage(root, ".hidden", { name: "hidden", dsh: { bundle: {} } });
    writePackage(root, "pkg", { name: "pkg", dsh: { bundle: {} } });
    writePackage(root, "pkg/examples/nested", {
      name: "nested",
      dsh: { bundle: {} },
    });

    expect(listSandboxPluginBundles(root).map((item) => item.path)).toEqual([
      "pkg",
    ]);
  });

  it("package.json 损坏或缺失时跳过（不炸扫描）", () => {
    const root = makeRoot();
    mkdirSync(join(root, "broken"), { recursive: true });
    writeFileSync(join(root, "broken", "package.json"), "{ not json", "utf8");
    mkdirSync(join(root, "empty"), { recursive: true });

    expect(listSandboxPluginBundles(root)).toEqual([]);
  });

  it("深度受限：超过 maxDepth 的 bundle 不收录", () => {
    const root = makeRoot();
    writePackage(root, "a/b/c/d", { name: "deep", dsh: { bundle: {} } });

    expect(listSandboxPluginBundles(root, { maxDepth: 2 })).toEqual([]);
    expect(
      listSandboxPluginBundles(root, { maxDepth: 4 }).map((i) => i.path),
    ).toEqual(["a/b/c/d"]);
  });
});
