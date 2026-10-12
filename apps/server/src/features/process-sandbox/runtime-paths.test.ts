import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runtimeLayout } from "../../desktop/runtimes.js";
import { resolveProcessRuntime } from "./runtime-paths.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** 造一个发布包布局：<root>/runtime/<name>/…（probe 文件必须有，否则视为未捆绑）。 */
function fakeBundle() {
  const root = mkdtempSync(join(tmpdir(), "kfw-runtime-paths-"));
  dirs.push(root);
  const layout = (name: "node" | "python" | "uv" | "java") =>
    runtimeLayout(name, process.platform);
  for (const name of ["node", "python", "uv", "java"] as const) {
    const bin = join(root, "runtime", layout(name).dir, layout(name).bin);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, layout(name).probe), "");
  }
  return root;
}

it("runtimeReadRoots 覆盖全部随包运行时（不只 Node）——否则沙箱里 python 跑不了", () => {
  const resourceRoot = fakeBundle();
  const resolved = resolveProcessRuntime({ resourceRoot, env: {} });
  const roots = resolved.runtimeReadRoots.map((path) => path.replaceAll("\\", "/"));
  const expected = (["node", "python", "uv", "java"] as const).map((name) => {
    const layout = runtimeLayout(name, process.platform);
    const binDir = join(resourceRoot, "runtime", layout.dir, layout.bin);
    // homeOf：bin 非空时取上一级（java 的根是 runtime/jdk）
    const homeDir = layout.bin ? join(resourceRoot, "runtime", layout.dir) : binDir;
    return homeDir.replaceAll("\\", "/");
  });
  for (const dir of expected) {
    expect(roots, `runtimeReadRoots 缺 ${dir}`).toContain(dir);
  }
  // 去重
  expect(new Set(roots).size).toBe(roots.length);
  // PATH 前置项 = 各运行时的 bin 目录（与 readRoots 成对）
  const bins = resolved.runtimePathAdditions.map((path) => path.replaceAll("\\", "/"));
  expect(bins).toContain(join(resourceRoot, "runtime", "python").replaceAll("\\", "/"));
  expect(bins).toContain(join(resourceRoot, "runtime", "node").replaceAll("\\", "/"));
  expect(new Set(bins).size).toBe(bins.length);
  // helper Node 路径仍解析得到
  expect(resolved.nodePath.length).toBeGreaterThan(0);
});

it("一个随包运行时都没有时，退化成 helper Node 所在目录（不抛错）", () => {
  const empty = mkdtempSync(join(tmpdir(), "kfw-runtime-empty-"));
  dirs.push(empty);
  const resolved = resolveProcessRuntime({
    resourceRoot: empty,
    env: {},
    // 没有发布包布局时必须显式给 helper 源（否则按设计 fail loud）。
    sourceHelperPath: fileURLToPath(new URL("./task-helper.ts", import.meta.url)),
  });
  // 非 SEA 形态下 nodePath 回落到 process.execPath，可读根就是它所在目录。
  expect(resolved.runtimeReadRoots).toEqual([dirname(process.execPath)]);
  // 没有随包运行时就没有 PATH 前置项（不改宿主 PATH 口径）。
  expect(resolved.runtimePathAdditions).toEqual([]);
});
