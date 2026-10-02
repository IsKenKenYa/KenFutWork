import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const { parse } = createRequire(import.meta.url)("@babel/parser");

// 固定源码与实际复制记录；只负责机械移植，不生成或仿制界面。
const root = resolve(import.meta.dirname, "..");
const donor = join(root, "references/zcode");
const donorManifest = JSON.parse(
  readFileSync(join(donor, "package.json"), "utf8"),
);
const uiTarget = join(root, "apps/web/src/components/workbench/zcode");
const revision = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";
const inventoryPath = join(root, "docs/源码来源/ZCode源码清单.json");
// 已建立清单后默认只核对，禁止重新复制覆盖宿主接线或并行修改。
if (existsSync(inventoryPath)) {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const drift = inventory.records.filter((record) => {
    const source = join(root, record.source);
    const target = join(root, record.target);
    return (
      !existsSync(source) ||
      !existsSync(target) ||
      createHash("sha256").update(readFileSync(source)).digest("hex") !==
        record.sha256 ||
      createHash("sha256").update(readFileSync(target)).digest("hex") !==
        record.copiedSha256
    );
  });
  if (inventory.revision !== revision)
    throw new Error("源码清单的提交与固定基线不一致");
  process.stdout.write(
    `已核对 ${inventory.records.length} 个来源文件，漂移 ${drift.length} 个。\n`,
  );
  if (drift.length) {
    process.stdout.write(
      drift.map((record) => record.target).join("\n") + "\n",
    );
    process.exitCode = 1;
  }
  // exit 不执行后续复制；适配清单必须在每次经审查的源改动后显式更新。
} else {
  const packageNames = [
    "ui",
    "shared",
    "services",
    "provider",
    "rpc",
    "model-option-map",
    "zcode-cua",
  ];
  const packages = new Map(
    packageNames.map((name) => {
      const path = join(donor, "packages", name);
      return [
        `@zcode/${name}`,
        {
          name,
          path,
          manifest: JSON.parse(
            readFileSync(join(path, "package.json"), "utf8"),
          ),
          target:
            name === "ui"
              ? uiTarget
              : join(root, "packages", `zcode-${name.replace(/^zcode-/, "")}`),
          files: new Set(),
          dependencies: new Set(),
        },
      ];
    }),
  );
  const records = [];

  function walk(path) {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const file = join(path, entry.name);
      return entry.isDirectory() ? walk(file) : [file];
    });
  }

  function sourceFile(path) {
    const candidates = [
      path,
      path.replace(/\.js$/, ".ts"),
      path.replace(/\.js$/, ".tsx"),
      path.replace(/\.js$/, ".d.ts"),
      `${path}.ts`,
      `${path}.tsx`,
      join(path, "index.ts"),
    ];
    return candidates.find(
      (candidate) => existsSync(candidate) && !readdirSafe(candidate),
    );
  }

  function readdirSafe(path) {
    try {
      readdirSync(path);
      return true;
    } catch {
      return false;
    }
  }

  function exportPath(pkg, specifier) {
    const key =
      specifier === pkg.manifest.name
        ? "."
        : `.${specifier.slice(pkg.manifest.name.length)}`;
    const entry = pkg.manifest.exports[key];
    if (!entry) throw new Error(`缺少真实源导出：${specifier}`);
    const target =
      typeof entry === "string"
        ? entry
        : (entry.import ?? entry.default ?? entry.types);
    // rpc 的公开 types 已构建才有；移植始终取真实 src。
    return sourceFile(join(pkg.path, target));
  }

  function collect(pkg, file) {
    if (!file || pkg.files.has(file)) return;
    pkg.files.add(file);
    if (!/\.(?:[cm]?tsx?|[cm]?jsx?)$/.test(file)) return;
    const content = readFileSync(file, "utf8");
    const parsed = parse(content, {
      sourceType: "module",
      plugins: [
        ["typescript", { dts: file.endsWith(".d.ts") }],
        ...(file.endsWith("tsx") || file.endsWith("jsx") ? ["jsx"] : []),
      ],
    });
    const imports = new Set();
    const visit = (node) => {
      if (typeof node !== "object" || node === null) return;
      if (
        [
          "ImportDeclaration",
          "ExportNamedDeclaration",
          "ExportAllDeclaration",
          "ImportExpression",
        ].includes(node.type) &&
        typeof node.source?.value === "string"
      )
        imports.add(node.source.value);
      if (
        node.type === "TSImportType" &&
        typeof node.argument?.value === "string"
      )
        imports.add(node.argument.value);
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "Import" &&
        typeof node.arguments[0]?.value === "string"
      )
        imports.add(node.arguments[0].value);
      for (const [key, child] of Object.entries(node)) {
        if (["loc", "start", "end", "comments", "tokens"].includes(key))
          continue;
        if (Array.isArray(child)) child.forEach(visit);
        else visit(child);
      }
    };
    visit(parsed);
    for (const raw of imports) {
      const spec = raw.split("?")[0];
      if (spec.startsWith("."))
        collect(pkg, sourceFile(resolve(dirname(file), spec)));
      else if (spec.startsWith("@/") && pkg.name === "ui")
        collect(pkg, sourceFile(join(pkg.path, "src", spec.slice(2))));
      else if (spec.startsWith("#src/"))
        collect(pkg, sourceFile(join(pkg.path, "src", spec.slice(5))));
      else if (spec.startsWith("@zcode/")) {
        const name = spec.split("/").slice(0, 2).join("/");
        const dependency = packages.get(name);
        if (!dependency)
          throw new Error(`界面依赖了移植边界之外的包：${spec}（${file}）`);
        if (dependency !== pkg) pkg.dependencies.add(name);
        collect(dependency, exportPath(dependency, spec));
      } else if (!spec.startsWith("node:")) {
        pkg.dependencies.add(
          spec.startsWith("@")
            ? spec.split("/").slice(0, 2).join("/")
            : spec.split("/")[0],
        );
      }
    }
  }

  const ui = packages.get("@zcode/ui");
  for (const file of walk(join(ui.path, "src"))) collect(ui, file);
  // 独立编译工程需要真实 public root，而非 hand-written ambient 声明。
  for (const name of [
    "shared",
    "services",
    "provider",
    "rpc",
    "model-option-map",
  ]) {
    const pkg = packages.get(`@zcode/${name}`);
    collect(pkg, join(pkg.path, "src/index.ts"));
  }

  for (const pkg of packages.values()) {
    rmSync(pkg.target, { recursive: true, force: true });
    mkdirSync(pkg.target, { recursive: true });
    const adapt =
      pkg.name === "ui"
        ? ["@/ 导入机械映射为 @zui/；独立构建保持上游 TypeScript 检查口径"]
        : [];
    for (const file of [...pkg.files].sort()) {
      const path = relative(pkg.path, file);
      const targetPath = pkg.name === "ui" ? path.replace(/^src\//, "") : path;
      const destination = join(pkg.target, targetPath);
      mkdirSync(dirname(destination), { recursive: true });
      const original = readFileSync(file);
      let copied = original;
      if (pkg.name === "ui" && /\.(?:tsx?|jsx?)$/.test(file))
        copied = Buffer.from(
          original.toString("utf8").replace(/(["'])@\//g, "$1@zui/"),
        );
      writeFileSync(destination, copied);
      records.push({
        source: relative(root, file),
        target: relative(root, destination),
        sha256: createHash("sha256").update(original).digest("hex"),
        copiedSha256: createHash("sha256").update(copied).digest("hex"),
        adaptations: adapt,
      });
    }
    const dependencies = {};
    const known = {
      ...donorManifest.dependencies,
      ...donorManifest.devDependencies,
      ...pkg.manifest.dependencies,
      ...pkg.manifest.devDependencies,
      ...pkg.manifest.peerDependencies,
    };
    for (const dependency of [...pkg.dependencies].sort()) {
      if (["react", "react-dom"].includes(dependency)) continue;
      if (dependency.startsWith("@zcode/"))
        dependencies[dependency] = "workspace:*";
      else if (known[dependency])
        dependencies[dependency] =
          dependency === "@pierre/diffs" ? "1.1.22" : known[dependency];
      else throw new Error(`上游未声明依赖：${dependency}（${pkg.name}）`);
    }
    const hasSource = existsSync(join(pkg.target, "src")) || pkg.name === "ui";
    const exports = {};
    for (const [key, entry] of Object.entries(pkg.manifest.exports)) {
      const raw =
        typeof entry === "string"
          ? entry
          : (entry.import ?? entry.default ?? entry.types);
      const file = sourceFile(join(pkg.path, raw));
      if (!file || !pkg.files.has(file)) continue;
      const path = relative(pkg.path, file);
      if (path.startsWith("src/")) {
        const leaf = path.slice(4).replace(/\.(?:tsx?|jsx?)$/, "");
        exports[key] = {
          types: `./dist/${leaf}.d.ts`,
          default: `./dist/${leaf}.js`,
        };
      } else exports[key] = entry;
    }
    if (pkg.name === "ui") {
      exports["."] = {
        types: "./dist-host/host-entry.d.ts",
        default: "./dist/code-ui.js",
      };
      exports["./styles.css"] = "./dist/code-ui.css";
    }
    writeFileSync(
      join(pkg.target, "package.json"),
      `${JSON.stringify({ name: pkg.manifest.name, private: true, type: "module", license: "Apache-2.0", exports, ...(hasSource ? { scripts: { build: pkg.name === "ui" ? "tsc -p tsconfig.vendor.json && vite build" : "tsc -p tsconfig.json", typecheck: pkg.name === "ui" ? "tsc -p tsconfig.vendor.json --noEmit" : "tsc -p tsconfig.json --noEmit" } } : {}), dependencies, devDependencies: hasSource ? { "@types/node": "^25.5.0", typescript: "^6.0.2" } : {}, ...(pkg.name === "ui" ? { peerDependencies: { react: "^19.2.0", "react-dom": "^19.2.0" } } : {}) }, null, 2)}\n`,
    );
    if (hasSource && pkg.name !== "ui")
      writeFileSync(
        join(pkg.target, "tsconfig.json"),
        `${JSON.stringify({ compilerOptions: { target: "ES2024", lib: ["ES2025", "DOM"], module: "NodeNext", moduleResolution: "NodeNext", outDir: "dist", rootDir: "src", declaration: true, sourceMap: true, esModuleInterop: true, resolveJsonModule: true, skipLibCheck: true, isolatedModules: true, noUncheckedIndexedAccess: true, strict: ["rpc", "provider"].includes(pkg.name), exactOptionalPropertyTypes: false }, include: ["src/**/*.ts", "src/**/*.json"] }, null, 2)}\n`,
      );
  }

  const inventory = join(root, "docs/源码来源/ZCode源码清单.json");
  mkdirSync(dirname(inventory), { recursive: true });
  writeFileSync(
    inventory,
    `${JSON.stringify({ revision, version: "3.14.3", license: "Apache-2.0", records }, null, 2)}\n`,
  );
  process.stdout.write(
    `已机械移植 ${records.length} 个真实源码／资源文件；来源：${revision}\n`,
  );
}
