import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 由 server/desktop packaging 调用；不加载服务端 env，不启动执行进程。
const destination = process.argv[2];
if (!destination) throw new Error("请传入进程 helper 的输出目录。");
const output = resolve(destination);
const source = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// require.resolve 在 Windows 返回 `D:\...`，而 ESM loader 只认 file:// URL（CI 实测
// ERR_UNSUPPORTED_ESM_URL_SCHEME），故必须先转成 URL。
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href);
await mkdir(output, { recursive: true });
if (process.platform === "darwin") {
  // 一次性构建参数，不是业务运行时治理值；发布包不依赖用户机器安装编译器。
  execFileSync("/usr/bin/cc", [
    "-std=c11",
    "-O2",
    join(source, "native", "posix-session.c"),
    "-lproc",
    "-o",
    join(output, "pty-session-inspector"),
  ]);
}
if (process.platform === "linux") {
  execFileSync("/usr/bin/cc", [
    "-std=c11",
    "-O2",
    join(source, "native", "linux-process-range.c"),
    "-o",
    join(output, "linux-process-inspector"),
  ]);
}
await build({
  entryPoints: [join(source, "task-helper.ts")],
  outfile: join(output, "task-helper.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // 只把「随包 materialize 的原生重依赖」留在外部；其余包（含 @kenfutwork/shared
  // 及其 zod / @zcode/shared 运行时闭包）打进单文件。此前用 `packages: "external"`
  // 把 @kenfutwork/shared 一并外置，而 materialize 清单里没有它——打包后的 helper
  // 启动即 `ERR_MODULE_NOT_FOUND: Cannot find package '@kenfutwork/shared'`
  // （打包冒烟第 7 步「shadow checkpoint 空列表」的真根因；2026-10-13 在
  // release/process-helper 直跑 task-helper.mjs 复现）。
  external: ["@anthropic-ai/sandbox-runtime", "node-pty"],
  sourcemap: false,
});

async function packageRoot(name, resolver) {
  let entry;
  try {
    entry = resolver.resolve(`${name}/package.json`);
  } catch {
    entry = resolver.resolve(name);
  }
  let directory = dirname(entry);
  for (;;) {
    try {
      const manifest = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
      if (manifest.name === name)
        return { directory: await realpath(directory), manifest };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`找不到运行时依赖的 package.json：${name}`);
    directory = parent;
  }
}

const copied = [];
async function materializeDependency(
  name,
  resolver,
  nodeModules,
  ancestors = new Set(),
) {
  const { directory, manifest } = await packageRoot(name, resolver);
  if (ancestors.has(directory)) return;
  const destination = join(nodeModules, ...name.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await cp(directory, destination, {
    recursive: true,
    dereference: true,
    filter: (path) =>
      !path.slice(directory.length).split(/[\\/]/).includes("node_modules"),
  });
  if (name === "node-pty" && process.platform === "darwin") {
    for (const relative of [
      "build/Release",
      "build/Debug",
      `prebuilds/${process.platform}-${process.arch}`,
    ]) {
      const helper = join(destination, relative, "spawn-helper");
      try {
        await access(helper);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      await chmod(helper, 0o755);
    }
  }
  copied.push({
    name,
    version: manifest.version,
    license: manifest.license,
    path: destination.slice(output.length + 1),
  });
  const childResolver = createRequire(join(directory, "package.json"));
  const chain = new Set([...ancestors, directory]);
  for (const child of Object.keys({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  })) {
    await materializeDependency(
      child,
      childResolver,
      join(destination, "node_modules"),
      chain,
    );
  }
}

const srt = await packageRoot("@anthropic-ai/sandbox-runtime", require);
if (srt.manifest.version !== "0.0.78")
  throw new Error("发布 helper 必须使用固定 SRT 0.0.78。");
await materializeDependency(
  "@anthropic-ai/sandbox-runtime",
  require,
  join(output, "node_modules"),
);
const pty = await packageRoot("node-pty", require);
await materializeDependency("node-pty", require, join(output, "node_modules"));
// 只保留与本机构筑对应的 node-pty 预编译：arm64 包里躺一份 darwin-x64 的
// pty.node + spawn-helper 没人会加载，还会让逐二进制造假检查多报两个未封印目标
//（CI 实测就是这个）。
const prebuilds = join(output, "node_modules", "node-pty", "prebuilds");
const keepPrebuild = `${process.platform}-${process.arch}`;
for (const entry of await readdir(prebuilds, { withFileTypes: true }).catch(
  () => [],
)) {
  if (entry.isDirectory() && entry.name !== keepPrebuild)
    await rm(join(prebuilds, entry.name), { recursive: true, force: true });
}
await writeFile(
  join(output, "package.json"),
  JSON.stringify(
    {
      name: "@kenfutwork/task-process-helper",
      private: true,
      type: "module",
      engines: { node: ">=22.12.0" },
      dependencies: {
        "@anthropic-ai/sandbox-runtime": "0.0.78",
        "node-pty": pty.manifest.version,
      },
    },
    null,
    2,
  ),
);
await writeFile(
  join(output, "runtime-dependencies.json"),
  JSON.stringify(copied, null, 2),
);
await cp(join(source, "native", "licenses"), join(output, "licenses"), {
  recursive: true,
});
await copyFile(join(source, "sources.json"), join(output, "sources.json"));

const native = process.argv[3];
if (native) {
  await access(native);
  await copyFile(native, join(output, "process-broker.exe"));
}

// 打包自检：产物里的裸包引用必须都能在随包 node_modules 里解析到——helper 在用户机器上
// 没有仓库的 node_modules 可退，缺一个就是「启动即崩」（2026-10-13 的 @kenfutwork/shared
// 事故：bundle 里残留裸 import，materialize 清单却没有它）。materialize 清单（含递归子
// 依赖）之外的包引用一律拒绝出包，宁可打不出包也不要发一个跑不起来的 helper。
const bundled = await readFile(join(output, "task-helper.mjs"), "utf8");
const materialized = new Set(copied.map((entry) => entry.name));
const missing = new Set();
for (const pattern of [/from\s+"([^"]+)"/g, /require\("([^"]+)"\)/g]) {
  for (const match of bundled.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier.startsWith("node:") || specifier.startsWith(".")) continue;
    const name = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    if (!materialized.has(name)) missing.add(name);
  }
}
if (missing.size > 0) {
  throw new Error(
    `helper 产物含未随包的运行时依赖：${[...missing].join("、")}。` +
      "把它们打进 bundle（esbuild external 只留 materialize 清单里的包），或补进 materialize 清单。",
  );
}
console.log(`进程 helper 已生成：${output}`);
