import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 由 server/desktop packaging 调用；不加载服务端 env，不启动执行进程。
const destination = process.argv[2];
if (!destination) throw new Error("请传入进程 helper 的输出目录。");
const output = resolve(destination);
const source = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { build } = await import(require.resolve("esbuild"));
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
  packages: "external",
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
console.log(`进程 helper 已生成：${output}`);
