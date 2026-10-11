import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 独立输入进程与原生库必须随包交付，不能依赖用户的源码目录或pnpm布局。
const destination = process.argv[2];
if (!destination) throw new Error("请传入桌面控制 helper 的输出目录。");
if (process.platform !== "darwin")
  throw new Error("本次桌面控制 helper 打包只验收macOS。");
const output = resolve(destination);
const source = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// require.resolve 在 Windows 返回 `D:\...`，而 ESM loader 只认 file:// URL（CI 实测
// ERR_UNSUPPORTED_ESM_URL_SCHEME），故必须先转成 URL。
const { build } = await import(pathToFileURL(require.resolve("esbuild")).href);
await mkdir(output, { recursive: true });
// 原市场/安装消费者按.app工作目录的plugins读取自带bundle；源码目录不能代替发行资源。
await cp(
  fileURLToPath(
    new URL("../../../../../plugins/computer-use/", import.meta.url),
  ),
  join(dirname(output), "plugins", "computer-use"),
  { recursive: true, dereference: true },
);
await build({
  entryPoints: [join(source, "input-worker.ts")],
  outfile: join(output, "input-worker.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: [
    "@computer-use/libnut-darwin",
    "@computer-use/libnut-linux",
    "@computer-use/libnut-win32",
  ],
  legalComments: "external",
});

const nutRequire = createRequire(require.resolve("@computer-use/nut-js"));
const libnutRequire = createRequire(nutRequire.resolve("@computer-use/libnut"));
const permissionsRequire = createRequire(
  require.resolve("@computer-use/node-mac-permissions"),
);
const bindingsRequire = createRequire(permissionsRequire.resolve("bindings"));
const dependencies = [
  ["@computer-use/libnut-darwin", libnutRequire],
  ["@computer-use/node-mac-permissions", require],
  ["bindings", permissionsRequire],
  ["file-uri-to-path", bindingsRequire],
];
const manifests = [];
for (const [name, resolver] of dependencies) {
  const directory = dirname(resolver.resolve(`${name}/package.json`));
  await cp(directory, join(dirname(output), "node_modules", name), {
    recursive: true,
    dereference: true,
  });
  const manifest = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  manifests.push({
    name,
    version: manifest.version,
    license: manifest.license,
  });
}
await writeFile(
  join(output, "runtime-dependencies.json"),
  JSON.stringify(manifests, null, 2),
);
console.log(`macOS桌面控制 helper 已生成：${output}`);
