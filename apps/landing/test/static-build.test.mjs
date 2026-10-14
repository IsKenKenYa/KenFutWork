import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

test("静态入口及 CSS 资源支持 Pages 子路径部署", () => {
  const html = readFileSync(resolve(dist, "index.html"), "utf8");
  const entries = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(
    entries.some((entry) => entry.endsWith(".js")),
    "入口脚本已构建",
  );
  assert.ok(
    entries.some((entry) => entry.endsWith(".css")),
    "页面样式已构建",
  );
  for (const entry of entries) {
    assert.ok(entry.startsWith("./"), `入口使用相对资源路径: ${entry}`);
    assert.ok(existsSync(resolve(dist, entry)), `入口资源存在: ${entry}`);
  }
  const cssFiles = readdirSync(resolve(dist, "assets")).filter((name) =>
    name.endsWith(".css"),
  );
  for (const name of cssFiles) {
    const file = resolve(dist, "assets", name);
    const css = readFileSync(file, "utf8");
    const assets = [...css.matchAll(/url\(["']?([^)'"\s]+)["']?\)/g)];
    assert.ok(assets.length > 0, "页面包含本地背景与字体");
    for (const [, asset] of assets) {
      assert.ok(!asset.startsWith("/"), `CSS 资源不依赖根路径: ${asset}`);
      assert.ok(
        existsSync(resolve(dirname(file), asset)),
        `CSS 资源存在: ${asset}`,
      );
    }
  }
});

test("品牌素材和字体许可随静态产物分发", () => {
  for (const asset of [
    "assets/logo-mark.png",
    "assets/hero-logo-halftone.png",
    "favicon.png",
    "fonts/momo-trust-display.woff2",
    "fonts/LICENSE.txt",
  ]) {
    assert.ok(existsSync(resolve(dist, asset)), `分发文件存在: ${asset}`);
  }
  assert.match(
    readFileSync(resolve(dist, "fonts/LICENSE.txt"), "utf8"),
    /SIL OPEN FONT LICENSE/,
  );
});
