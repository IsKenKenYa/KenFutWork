#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * 拉取随包分发的语言运行时（Node / Python / uv / JDK）到 `runtime/`。
 *
 * 为什么：桌面包是 Node SEA 单 exe，但 agent 的 `execute` 跑在**宿主机**上——用户
 * 机器没装 Node/Python/JDK 时，「建 python 项目」「跑一段 Java」「npx 起 MCP server」
 * 都不可用。本脚本把四者下载到仓库根的 `runtime/`（已 gitignore），打包脚本再拷进
 * 发布包（`<exeDir>/runtime/…`，由 desktop/runtimes.ts 解析并注入 sandbox PATH）。
 *
 * 形态与校验（四者都必须拿到**官方校验值**，拿不到即 fail loud）：
 *   - Node：官方 dist zip + 同目录 `SHASUMS256.txt`；
 *   - Python：astral-sh/python-build-standalone 最新发布的 `install_only.tar.gz`
 *     + 该发布的 `SHA256SUMS`（按系列挑补丁号最大的构建，含 pip）；
 *   - uv：astral-sh/uv 最新发布的 windows x64 zip + 逐资产 `.sha256`
 *     （Python 侧 MCP server 官方用 `uvx` 拉起，CPython 不自带它）；
 *   - JDK：Adoptium API 直链 + 其 `checksum` 返回值校验（这里取 JRE 形态以控体积）。
 *
 * 幂等：目标目录已存在且可执行体在，则跳过（`--force` 重下）。
 * 用法：node scripts/fetch-runtimes.mjs [--only node,python,uv,jdk] [--force]
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const RUNTIME_DIR = join(ROOT, "runtime");

/**
 * 每个运行时声明 `probe`（解压后必须存在的可执行体）+ `resolve(version)` → 下载地址与
 * **官方校验来源**。三者都拿不到官方校验值就拒绝安装（fail loud）：
 *   node   → nodejs.org 的 SHASUMS256.txt
 *   python → astral-sh/python-build-standalone 的 SHA256SUMS（`install_only` 形态解压即得 python/）
 *   jdk    → Adoptium assets API 的 checksum（取 JRE 形态控体积）
 */
const SPECS = {
  node: {
    version: "22.20.0",
    probe: "node.exe",
    resolve: async (version) => ({
      url: `https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip`,
      sumsUrl: `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
    }),
  },
  python: {
    /** 目标 CPython **系列**；补丁号与构建号从最新发布里挑（挑不到即 fail loud）。 */
    series: "3.12",
    probe: "python.exe",
    resolve: async (series) => resolvePythonAsset(series),
  },
  uv: {
    /** uv 版本随最新发布走（资产名只含平台不含版本，故从 latest 解析）。 */
    probe: "uvx.exe",
    resolve: async () => resolveUvAsset(),
  },
  jdk: {
    version: "21",
    probe: join("bin", "java.exe"),
    resolve: async (version) => ({
      url: `https://api.adoptium.net/v3/binary/latest/${version}/ga/windows/x64/jre/hotspot/normal/eclipse`,
      checksumUrl: `https://api.adoptium.net/v3/assets/latest/${version}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`,
    }),
  },
};

function parseArgs(argv) {
  const onlyArg = argv.find((a) => a.startsWith("--only="));
  const only = onlyArg
    ? onlyArg
        .slice("--only=".length)
        .split(",")
        .map((s) => s.trim())
    : Object.keys(SPECS);
  return { only, force: argv.includes("--force") };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function log(message) {
  console.log(`[runtimes] ${message}`);
}

function findInnerDir(extractDir) {
  const entries = readdirSync(extractDir).filter((name) =>
    statSync(join(extractDir, name)).isDirectory(),
  );
  return entries.length === 1 ? entries[0] : null;
}

/**
 * 解压用的 tar：Windows 上用系统自带 bsdtar（`%SystemRoot%\System32\tar.exe`，
 * 能解 zip 与 tar.gz）；POSIX 用 PATH 里的 tar。**不要**用 Git Bash 的 GNU tar——
 * 它既读不了 zip，又会把 `D:\...` 当远程主机。
 */
function resolveTarBinary() {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const candidate = join(systemRoot, "System32", "tar.exe");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "tar";
}

/** 解压 zip 到目标目录，并把顶层目录拍平（`<target>/<probe>` 就位）。 */
function extractFlat(zipPath, targetDir, probe) {
  const staging = `${targetDir}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    // Windows 10+ 自带 tar 能解 zip/tar.gz（避免引入额外依赖）。
    // 注意：GNU tar（Git Bash）会把 `D:\...` 当成远程主机（Cannot connect to D:），
    // 故统一用**相对路径 + cwd=RUNTIME_DIR**。
    execFileSync(
      resolveTarBinary(),
      [
        "-xf",
        relative(RUNTIME_DIR, zipPath),
        "-C",
        relative(RUNTIME_DIR, staging),
      ],
      { cwd: RUNTIME_DIR, stdio: "pipe" },
    );
    const inner = findInnerDir(staging);
    const source = inner ? join(staging, inner) : staging;
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(dirname(targetDir), { recursive: true });
    renameSync(source, targetDir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const probePath = join(targetDir, probe);
  if (!existsSync(probePath)) {
    throw new Error(`解压后找不到 ${basename(probePath)}（${targetDir}）`);
  }
}

const PYTHON_RELEASE_API =
  "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest";
const UV_RELEASE_API =
  "https://api.github.com/repos/astral-sh/uv/releases/latest";
const UV_ASSET_NAME = "uv-x86_64-pc-windows-msvc.zip";

/**
 * 在 portable-standalone 最新发布里挑 `cpython-<series>.<patch>+<build>-x86_64-pc-windows-msvc-install_only.tar.gz`
 * 中补丁号最大的那个（发布里的补丁号随上游走，硬编码某个补丁号会因上游发版而失效）。
 */
async function resolvePythonAsset(series) {
  const release = await (await fetch(PYTHON_RELEASE_API)).json();
  const assets = release?.assets ?? [];
  const pattern = new RegExp(
    `^cpython-${series.replace(/\./g, "\\.")}\\.(\\d+)\\+\\d+-x86_64-pc-windows-msvc-install_only\\.tar\\.gz$`,
  );
  const matched = assets.filter((item) => pattern.test(item.name ?? ""));
  const chosen = matched.sort(
    (a, b) => Number(pattern.exec(b.name)[1]) - Number(pattern.exec(a.name)[1]),
  )[0];
  const sumsAsset = assets.find((item) => item.name === "SHA256SUMS");
  if (!chosen || !sumsAsset) {
    throw new Error(
      `portable-standalone 发布（${release?.tag_name ?? "?"}）里找不到 python ${series}.x 的 windows 资产或 SHA256SUMS（fail loud）。`,
    );
  }
  log(`python 选中 ${chosen.name}（发布 ${release.tag_name}）`);
  return {
    url: chosen.browser_download_url,
    sumsUrl: sumsAsset.browser_download_url,
    // 下载地址里的 `+` 是百分号编码（%2B），而 SHASUMS 里写的是原始文件名——按名查行。
    fileName: chosen.name,
  };
}

/** 在 uv 最新发布里取 windows x64 zip 与其 `.sha256` 校验文件。 */
async function resolveUvAsset() {
  const release = await (await fetch(UV_RELEASE_API)).json();
  const assets = release?.assets ?? [];
  const asset = assets.find((item) => item.name === UV_ASSET_NAME);
  const sums = assets.find((item) => item.name === `${UV_ASSET_NAME}.sha256`);
  if (!asset || !sums) {
    throw new Error(
      `uv 最新发布（${release?.tag_name ?? "?"}）里找不到 ${UV_ASSET_NAME} 或其 .sha256（fail loud）。`,
    );
  }
  log(`uv 选中 ${asset.name}（发布 ${release.tag_name}）`);
  return {
    url: asset.browser_download_url,
    rawShaUrl: sums.browser_download_url,
    fileName: asset.name,
  };
}

/** 取官方校验值：SHASUMS 文件按文件名查行，Adoptium 则读 assets JSON 的 checksum。 */
async function resolveExpectedSha(resolved, url) {
  if (resolved.sumsUrl) {
    const sums = await (await fetch(resolved.sumsUrl)).text();
    const fileName = resolved.fileName ?? basename(url);
    const line = sums.split("\n").find((row) => row.trim().endsWith(fileName));
    return line ? (line.trim().split(/\s+/)[0] ?? null) : null;
  }
  // 逐资产校验文件（uv 的 `<asset>.sha256`：内容就是哈希，或「哈希 + 文件名」）
  if (resolved.rawShaUrl) {
    const text = (await (await fetch(resolved.rawShaUrl)).text()).trim();
    return text.split(/\s+/)[0] ?? null;
  }
  if (resolved.checksumUrl) {
    const assets = await (await fetch(resolved.checksumUrl)).json();
    return assets?.[0]?.binary?.package?.checksum ?? null;
  }
  return null;
}

async function fetchWithSha(spec, { force }) {
  const targetDir = join(RUNTIME_DIR, spec.name);
  if (!force && existsSync(join(targetDir, spec.probe))) {
    log(`${spec.name} 已存在，跳过（--force 可重下）：${targetDir}`);
    return;
  }

  const resolved = await spec.resolve(spec.version ?? spec.series);
  const url = resolved.url;
  log(`${spec.name} 下载：${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${spec.name} 下载失败：HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = sha256(buffer);

  const expected = await resolveExpectedSha(resolved, url);
  if (!expected) {
    throw new Error(`${spec.name} 拿不到官方校验值，拒绝安装（fail loud）。`);
  }
  if (expected !== digest) {
    throw new Error(
      `${spec.name} 校验失败：期望 ${expected}，实际 ${digest}（若官方更新了版本，请同步更新脚本里的版本/哈希）。`,
    );
  }
  log(`${spec.name} 校验通过（sha256=${digest.slice(0, 12)}…），解压中…`);

  const zipPath = join(RUNTIME_DIR, `${spec.name}.zip`);
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(zipPath, buffer);
  try {
    extractFlat(zipPath, targetDir, spec.probe);
  } finally {
    rmSync(zipPath, { force: true });
  }
  log(`${spec.name} 就位：${join(targetDir, spec.probe)}`);
}

async function main() {
  const { only, force } = parseArgs(process.argv.slice(2));
  const selected = Object.entries(SPECS).filter(([name]) =>
    only.includes(name),
  );
  if (selected.length === 0) {
    throw new Error(`--only 里没有可识别的运行时：${only.join(",")}`);
  }
  for (const [name, spec] of selected) {
    await fetchWithSha({ name, ...spec }, { force });
  }
  log(`完成。运行时目录：${RUNTIME_DIR}`);
  log("打包时 script/package-win.mjs 会把它拷进发布包的 <exeDir>/runtime/。");
}

main().catch((error) => {
  console.error(`[runtimes] 失败：${error.message}`);
  process.exitCode = 1;
});
