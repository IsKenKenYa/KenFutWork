import {
  type BundleFormat,
  PLUGIN_UI_SLOTS,
  type PluginBundleManifest,
  type PluginUiSlot,
  pluginBundleManifestSchema,
} from "@kenfutwork/shared";

import { type ModuleScan, scanPluginModule } from "./module-scan.js";
import { parsePatch } from "./patch-parser.js";

/**
 * `ctx.<成员>` → 规范能力名的别名表（其余成员与能力名同名）。
 *
 * 例：插件写 `ctx.promptFragments.register(...)`，对应能力名是 `systemPrompt`
 * （提示段能力）——不映射的话门禁会把它当成一项未识别能力而拒绝安装。
 */
const CTX_MEMBER_CAPABILITY_ALIASES: Record<string, string> = {
  promptFragments: "systemPrompt",
};

/**
 * bundle 清单归一化：把「一个插件的文件集合」收敛为 `PluginBundleManifest`。
 *
 * 同时支持两种声明（互操作的前提）：
 * - dsh 原生：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`
 * - 本项目：`package.json` 的 `kenfutwork.bundle`（同形状，便于同一产物两端加载；
 *   旧名 `loomic.bundle` 仍接受）
 *
 * 只有 `profile` 声明、没有 `bundle` 声明的包不是插件（dsh 的 profile 是组合清单，
 * 本项目不支持从上游导入 profile），按 `bundle_declaration_missing` 拒绝。
 */

/** 相对包根的文件路径 → 文本内容。二进制文件不进此结构。 */
export type BundleFiles = Record<string, string>;

export class BundleManifestError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "manifest_missing"
      | "bundle_declaration_missing"
      | "manifest_invalid",
  ) {
    super(message);
    this.name = "BundleManifestError";
  }
}

const LIFECYCLE_SCRIPT_NAMES = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
];

function findFile(files: BundleFiles, target: string): string | undefined {
  const normalized = target.replace(/^\.\//, "");
  for (const [path, content] of Object.entries(files)) {
    if (path.replace(/^\.\//, "") === normalized) return content;
  }
  return undefined;
}

function resolveEntry(
  pkg: Record<string, unknown>,
  files: BundleFiles,
): string | null {
  const main = typeof pkg.main === "string" ? pkg.main : undefined;
  if (main) return main.replace(/^\.\//, "");

  const exportsField = pkg.exports;
  if (typeof exportsField === "string")
    return exportsField.replace(/^\.\//, "");
  if (typeof exportsField === "object" && exportsField !== null) {
    const root = (exportsField as Record<string, unknown>)["."];
    if (typeof root === "string") return root.replace(/^\.\//, "");
    if (typeof root === "object" && root !== null) {
      const record = root as Record<string, unknown>;
      const candidate = record.import ?? record.default ?? record.require;
      if (typeof candidate === "string") return candidate.replace(/^\.\//, "");
    }
  }

  // 无显式入口时退回约定文件名
  for (const fallback of [
    "index.js",
    "index.mjs",
    "src/index.ts",
    "index.ts",
  ]) {
    if (findFile(files, fallback) !== undefined) return fallback;
  }
  return null;
}

/**
 * 识别 bundle 声明。产物通常**双声明**（同时带 `dsh.bundle` 与 `kenfutwork.bundle`），
 * 此时按 dsh 识别——dsh 生态更大，约定以它为主格式；两条声明指向同一配置层，
 * 功能上等价，故顺序不影响判定结果。
 */
function detectBundleDeclaration(pkg: Record<string, unknown>): {
  format: BundleFormat;
  patchPath: string;
} | null {
  const dsh = pkg.dsh as Record<string, unknown> | undefined;
  const dshPatch = dsh?.bundle as Record<string, unknown> | undefined;
  const dshPatchPath = dshPatch?.patch;
  if (typeof dshPatchPath === "string" && dshPatchPath.trim()) {
    return { format: "dsh", patchPath: dshPatchPath.replace(/^\.\//, "") };
  }

  // 旧名兼容：品牌统一前发布过的 bundle 用 `loomic.bundle`，安装端继续认
  const legacy = pkg.loomic as Record<string, unknown> | undefined;
  const legacyPatch = legacy?.bundle as Record<string, unknown> | undefined;
  const legacyPatchPath = legacyPatch?.patch;
  if (typeof legacyPatchPath === "string" && legacyPatchPath.trim()) {
    return {
      format: "kenfutwork",
      patchPath: legacyPatchPath.replace(/^\.\//, ""),
    };
  }

  const kenfutwork = pkg.kenfutwork as Record<string, unknown> | undefined;
  const kenfutworkPatch = kenfutwork?.bundle as
    | Record<string, unknown>
    | undefined;
  const kenfutworkPatchPath = kenfutworkPatch?.patch;
  if (typeof kenfutworkPatchPath === "string" && kenfutworkPatchPath.trim()) {
    return {
      format: "kenfutwork",
      patchPath: kenfutworkPatchPath.replace(/^\.\//, ""),
    };
  }
  return null;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

/** 从文件集合构建归一化清单；并返回模块扫描结果供门禁复用（避免重复解析）。 */
/** 只把对象当对象看（清单里的第三方字段可能是任意类型）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function buildBundleManifest(files: BundleFiles): {
  manifest: PluginBundleManifest;
  scan: ModuleScan;
} {
  const rawManifest = findFile(files, "package.json");
  if (rawManifest === undefined) {
    throw new BundleManifestError(
      "bundle 根目录缺少 package.json。",
      "manifest_missing",
    );
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(rawManifest) as Record<string, unknown>;
  } catch (error) {
    throw new BundleManifestError(
      `package.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      "manifest_invalid",
    );
  }

  const name = typeof pkg.name === "string" ? pkg.name.trim() : "";
  if (!name) {
    throw new BundleManifestError(
      "package.json 缺少 name。",
      "manifest_invalid",
    );
  }

  const declaration = detectBundleDeclaration(pkg);
  if (!declaration) {
    throw new BundleManifestError(
      "包未声明 `dsh.bundle.patch`（dsh 原生）或 `kenfutwork.bundle`（本项目；旧名 `loomic.bundle` 仍认），不是可安装的插件 bundle。",
      "bundle_declaration_missing",
    );
  }

  const patchSource = findFile(files, declaration.patchPath);
  if (patchSource === undefined) {
    throw new BundleManifestError(
      `声明的配置层文件不存在：${declaration.patchPath}`,
      "manifest_invalid",
    );
  }
  // patch 非法时抛出 PatchParseError，由调用方转为门禁报告
  const patch = parsePatch(patchSource);

  const entry = resolveEntry(pkg, files);
  const entrySource = entry ? findFile(files, entry) : undefined;
  const scan = entrySource ? scanPluginModule(entrySource) : emptyScan();

  const scripts = asStringRecord(pkg.scripts);
  const dependencies = asStringRecord(pkg.dependencies);
  const peerDependencies = asStringRecord(pkg.peerDependencies);
  const dshBaseDependencies = [
    ...Object.keys(dependencies),
    ...Object.keys(peerDependencies),
  ].filter((dep) => dep.startsWith("@deepseek-ai/"));

  const requirementNames = new Set<string>([
    ...patch.rows.flatMap((row) => row.inject),
    ...patch.overrides.flatMap((row) => row.inject),
    ...scan.declaredInject,
    // ctx 成员名 → 规范能力名：多数同名（tools/routes/ui），例外在此列一行
    ...scan.accessedMembers.map(
      (member) => CTX_MEMBER_CAPABILITY_ALIASES[member] ?? member,
    ),
  ]);

  const engines = pkg.engines as Record<string, unknown> | undefined;

  // UI 面板入口：`kenfutwork.ui`（本项目扩展；dsh 侧没有对应声明）。
  // 刻意放在厂商键下一级而不是 bundle 里：UI 不属于「配置层 patch」的概念。
  const kenfutworkBlock = asRecord(pkg.kenfutwork) ?? {};
  /** 是否托管 bundle 目录为静态资源（`kenfutwork.assets`）。 */
  const serveAssets = kenfutworkBlock.assets === true;
  const declaredUi = Array.isArray(kenfutworkBlock.ui)
    ? (kenfutworkBlock.ui as unknown[])
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item) => {
          const slot = String(item.slot ?? "sidebar");
          return {
            id: typeof item.id === "string" ? item.id : "",
            title: typeof item.title === "string" ? item.title : "",
            slot: (PLUGIN_UI_SLOTS as readonly string[]).includes(slot)
              ? (slot as PluginUiSlot)
              : "sidebar",
            url: typeof item.url === "string" ? item.url : "",
            icon: typeof item.icon === "string" && item.icon ? item.icon : null,
          };
        })
        .filter((item) => item.id && item.title && item.url)
    : [];

  const manifest = pluginBundleManifestSchema.parse({
    name,
    version:
      typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0",
    description: typeof pkg.description === "string" ? pkg.description : "",
    license: typeof pkg.license === "string" ? pkg.license : null,
    repositoryUrl: readRepositoryUrl(pkg),
    homepage: typeof pkg.homepage === "string" ? pkg.homepage : null,
    format: declaration.format,
    patchPath: declaration.patchPath,
    entry,
    requiredCapabilities: [...requirementNames],
    scope: kenfutworkBlock.scope ?? null,
    category:
      typeof kenfutworkBlock.category === "string" && kenfutworkBlock.category
        ? kenfutworkBlock.category
        : null,
    title:
      typeof kenfutworkBlock.title === "string" && kenfutworkBlock.title
        ? kenfutworkBlock.title
        : null,
    enginesNode:
      engines && typeof engines.node === "string" ? engines.node : null,
    ui: declaredUi,
    assets: serveAssets,
    hasClientUi:
      typeof pkg.dsh === "object" &&
      pkg.dsh !== null &&
      "client" in (pkg.dsh as object),
    lifecycleScripts: LIFECYCLE_SCRIPT_NAMES.filter(
      (script) => typeof scripts[script] === "string",
    ),
    dshBaseDependencies,
    hasNativeBuild:
      findFile(files, "binding.gyp") !== undefined ||
      Boolean(pkg.gypfile) ||
      Object.keys(dependencies).some((dep) => dep.startsWith("node-gyp")),
    dependencies,
    peerDependencies,
  });

  return { manifest, scan };
}

function emptyScan(): ModuleScan {
  return {
    declaredInject: [],
    accessedMembers: [],
    subscribedEvents: [],
    hasDynamicAccess: false,
    unsafeModules: [],
  };
}

function readRepositoryUrl(pkg: Record<string, unknown>): string | null {
  const repository = pkg.repository;
  if (typeof repository === "string") return repository;
  if (typeof repository === "object" && repository !== null) {
    const url = (repository as Record<string, unknown>).url;
    if (typeof url === "string") {
      return url.replace(/^git\+/, "").replace(/\.git$/, "");
    }
  }
  return null;
}

export { findFile };
