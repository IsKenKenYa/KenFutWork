import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadBundledBundles } from "./plugin.js";

/**
 * 自带插件目录解析：锁**打包布局契约**。
 *
 * 桌面发布包把仓库 `plugins/` 拷到应用目录，壳以该目录为服务端 cwd 拉起
 * （`apps/desktop/src-tauri/src/lib.rs` 的 `packaged_spawn_config`）——
 * 因此 `<cwd>/plugins` 必须被当作自带 bundle 目录；同时 env 覆盖（自托管指定目录）
 * 优先于它。两件事此前都没有测试盯着，导致「发布包不拷 plugins/」长期无人发现。
 */

/** 写一个最小可安装 bundle（声明 kenfutwork.bundle.patch、声明并使用 tools 能力）。 */
function writeBundle(rootDir: string, dirName: string, name: string): void {
  const dir = join(rootDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      main: "index.js",
      kenfutwork: { bundle: { patch: "./cordis.patch.yml" }, title: name },
    }),
  );
  writeFileSync(
    join(dir, "cordis.patch.yml"),
    `- insert:\n    - id: ${name}\n      name: ${name}\n      inject: [tools]\n`,
  );
  writeFileSync(
    join(dir, "index.js"),
    [
      `export const name = ${JSON.stringify(name)};`,
      'export const inject = ["tools"];',
      "export function apply(ctx) {",
      "  ctx.tools.register({",
      "    name: `${name}_ping`,",
      '    description: "ping",',
      '    parameters: { type: "object", properties: {} },',
      '    execute: () => "pong",',
      "  });",
      "}",
      "",
    ].join("\n"),
  );
}

describe("自带插件目录解析（打包布局契约）", () => {
  const originalCwd = process.cwd();
  const temps: string[] = [];
  const makeTemp = () => {
    const dir = mkdtempSync(join(tmpdir(), "kfw-plugins-"));
    temps.push(dir);
    return dir;
  };
  const silent = { warn: () => {} };

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cwd 下的 plugins/ 被当作自带 bundle 目录（桌面发布包靠它）", () => {
    const appDir = makeTemp();
    writeBundle(join(appDir, "plugins"), "demo", "kfw-test-demo");
    vi.stubEnv("KENFUTWORK_BUILTIN_PLUGINS_DIR", "");
    process.chdir(appDir);

    const bundles = loadBundledBundles(undefined, 22, silent);

    expect(bundles.map((bundle) => bundle.name)).toEqual(["kfw-test-demo"]);
    expect(bundles[0]?.id).toBe("bundled__kfw-test-demo");
    expect(bundles[0]?.report.compatible).toBe(true);
  });

  it("env 覆盖优先于 cwd（自托管指定目录时不被应用目录抢走）", () => {
    const appDir = makeTemp();
    writeBundle(join(appDir, "plugins"), "from-cwd", "kfw-from-cwd");
    const envDir = makeTemp();
    writeBundle(envDir, "from-env", "kfw-from-env");
    vi.stubEnv("KENFUTWORK_BUILTIN_PLUGINS_DIR", envDir);
    process.chdir(appDir);

    const bundles = loadBundledBundles(undefined, 22, silent);

    expect(bundles.map((bundle) => bundle.name)).toEqual(["kfw-from-env"]);
  });

  it("候选目录都不存在时返回空数组（不报错）", () => {
    const empty = makeTemp();
    vi.stubEnv("KENFUTWORK_BUILTIN_PLUGINS_DIR", "");
    process.chdir(empty);

    expect(loadBundledBundles(undefined, 22, silent)).toEqual([]);
  });

  it("门禁不过的 bundle 跳过并记 warn（一个坏目录不拖垮其余）", () => {
    const appDir = makeTemp();
    writeBundle(join(appDir, "plugins"), "good", "kfw-good");
    // 缺 kenfutwork.bundle 声明：不是可安装的插件 bundle
    const badDir = join(appDir, "plugins", "bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "package.json"), '{"name":"kfw-bad"}');
    vi.stubEnv("KENFUTWORK_BUILTIN_PLUGINS_DIR", "");
    process.chdir(appDir);

    const warnings: string[] = [];
    const bundles = loadBundledBundles(undefined, 22, {
      warn: (message) => warnings.push(message),
    });

    expect(bundles.map((bundle) => bundle.name)).toEqual(["kfw-good"]);
    expect(warnings.some((message) => message.includes("bad"))).toBe(true);
  });
});
