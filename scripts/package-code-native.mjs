import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

function packageRoot(entry) {
  let directory = dirname(entry);
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error("找不到 Canvas 原生运行时包。");
    directory = parent;
  }
  return directory;
}

/** PDF读取所需的真实原生Canvas；不可将.node塞进esbuild/SEA单文件。 */
export function packageCodeNativeRuntime(root, release) {
  const serverRequire = createRequire(join(root, "apps/server/package.json"));
  const canvas = packageRoot(serverRequire.resolve("@napi-rs/canvas"));
  const nativeName =
    process.platform === "darwin"
      ? `@napi-rs/canvas-darwin-${process.arch}`
      : process.platform === "win32"
        ? `@napi-rs/canvas-win32-${process.arch}-msvc`
        : null;
  if (!nativeName)
    throw new Error("此桌面打包入口只支持macOS/Windows Canvas运行时。");
  const canvasRequire = createRequire(join(canvas, "package.json"));
  const native = packageRoot(canvasRequire.resolve(nativeName));
  const target = join(release, "node_modules", "@napi-rs");
  mkdirSync(target, { recursive: true });
  cpSync(canvas, join(target, "canvas"), {
    recursive: true,
    dereference: true,
  });
  cpSync(native, join(release, "node_modules", nativeName), {
    recursive: true,
    dereference: true,
  });
  console.log(`[package] 已捆绑Canvas原生运行时：${nativeName}`);
}

export function packageRipgrepRuntime(root, release) {
  const serverRequire = createRequire(join(root, "apps/server/package.json"));
  const ripgrep = packageRoot(serverRequire.resolve("@vscode/ripgrep"));
  const nativeName = `@vscode/ripgrep-${process.platform}-${process.arch}`;
  const ripgrepRequire = createRequire(join(ripgrep, "package.json"));
  const native = packageRoot(
    ripgrepRequire.resolve(
      `${nativeName}/bin/${process.platform === "win32" ? "rg.exe" : "rg"}`,
    ),
  );
  const target = join(release, "node_modules", "@vscode");
  mkdirSync(target, { recursive: true });
  cpSync(ripgrep, join(target, "ripgrep"), {
    recursive: true,
    dereference: true,
  });
  cpSync(native, join(release, "node_modules", nativeName), {
    recursive: true,
    dereference: true,
  });
  console.log(`[package] 已捆绑搜索原生运行时：${nativeName}`);
}
