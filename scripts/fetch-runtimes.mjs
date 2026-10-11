#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
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
 * 可复现：仓库根若有 `runtime-lock.json`，解析到的资产名与下载后的哈希都必须命中它，
 * 不符即拒绝（同一 commit 两次出包拿到同一套运行时才是可对账的）。
 *   用法：node scripts/fetch-runtimes.mjs [--only node,python,uv,jdk] [--force]
 *   重锁：node scripts/fetch-runtimes.mjs --write-lock   （只改本目标平台那一节）
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
import { pathToFileURL } from "node:url";
import {
  assertLockAssetName,
  assertLockSha,
  buildLockEntry,
  LOCK_FILE_NAME,
  lockEntryFor,
  mergeLockTargets,
  readRuntimeLock,
} from "./runtime-lock.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const RUNTIME_DIR = join(ROOT, "runtime");

/**
 * 每个运行时声明 `probe`（解压后必须存在的可执行体）+ `resolve(version)` → 下载地址与
 * **官方校验来源**。三者都拿不到官方校验值就拒绝安装（fail loud）：
 *   node   → nodejs.org 的 SHASUMS256.txt
 *   python → astral-sh/python-build-standalone 的 SHA256SUMS（`install_only` 形态解压即得 python/）
 *   jdk    → Adoptium assets API 的 checksum（取 JRE 形态控体积）
 *
 * 按打包目标平台分支：Windows 资产沿用原 SPECS（win 打包机跑）；darwin-arm64 供
 * mac 打包（`package-mac.mjs`）。probe 必须与 `apps/server/src/desktop/runtimes.ts`
 * 的 RUNTIME_LAYOUT 布局互为镜像（那边怎么探，这边就怎么落）。
 */
const TARGET = (() => {
  if (process.platform === "win32") return "win-x64";
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "darwin-arm64";
  }
  if (process.platform === "darwin") return "darwin-x64";
  return `unsupported(${process.platform}/${process.arch})`;
})();

const SPECS = {
  "win-x64": {
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
      resolve: async (series) =>
        resolvePythonAsset(series, "x86_64-pc-windows-msvc"),
    },
    uv: {
      /** uv 版本随最新发布走（资产名只含平台不含版本，故从 latest 解析）。 */
      probe: "uvx.exe",
      resolve: async () => resolveUvAsset("uv-x86_64-pc-windows-msvc.zip"),
    },
    jdk: {
      version: "21",
      probe: join("bin", "java.exe"),
      resolve: async (version) => ({
        url: `https://api.adoptium.net/v3/binary/latest/${version}/ga/windows/x64/jre/hotspot/normal/eclipse`,
        checksumUrl: `https://api.adoptium.net/v3/assets/latest/${version}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`,
      }),
    },
    // MinGit（portable git）：用户要求「git 优先用本地自带的，打包的只作兜底」——
    // 兜底之所以需要，是因为「工作目录=项目」的分支视图要有可用的 git 才能干活。
    // 解压后是 cmd/ + mingw64/ 等多顶层目录，extractFlat 会整体落到 runtime/git。
    git: {
      probe: join("cmd", "git.exe"),
      resolve: async () => resolveMinGitAsset(),
    },
  },
  "darwin-arm64": {
    node: {
      version: "22.20.0",
      // darwin tarball 顶层是 node-v22…/bin/node（拍平后即 bin/node，非 Windows 的根上 node.exe）
      probe: join("bin", "node"),
      resolve: async (version) => ({
        url: `https://nodejs.org/dist/v${version}/node-v${version}-darwin-arm64.tar.gz`,
        sumsUrl: `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
      }),
    },
    // python-build-standalone 的 install_only.tar.gz 解出 python/bin/python3（bin/ 子目录，
    // 与 Windows 的根上 python.exe 不同构——runtimes.ts 的 darwin 布局与之镜像）。
    python: {
      series: "3.12",
      probe: join("bin", "python3"),
      resolve: async (series) =>
        resolvePythonAsset(series, "aarch64-apple-darwin"),
    },
    uv: {
      probe: "uvx",
      resolve: async () => resolveUvAsset("uv-aarch64-apple-darwin.tar.gz"),
    },
    // mac JDK 是 jdk-21…/Contents/Home/bin/java（Contents/Home 是 JAVA_HOME）。
    jdk: {
      version: "21",
      probe: join("Contents", "Home", "bin", "java"),
      resolve: async (version) => ({
        url: `https://api.adoptium.net/v3/binary/latest/${version}/ga/mac/aarch64/jre/hotspot/normal/eclipse`,
        checksumUrl: `https://api.adoptium.net/v3/assets/latest/${version}/hotspot?architecture=aarch64&image_type=jre&os=mac&vendor=eclipse`,
      }),
    },
    // git 不随包：mac 桌面场景宿主 git 优先（hasSystemGit 已平台感知），无兜底包。
  },
  "darwin-x64": null,
};

/**
 * `--only` 两种写法都得认：文件头的用法是 `--only node,python`（空格分隔），只认
 * `--only=` 会让前者**静默降级成「全部运行时」**——实测过一次，多下十几个 GB 的
 * 无关运行时还让人以为过滤生效了。裸 `--only` 不给值时宁可报错，不猜意图。
 */
export function parseArgs(argv, available) {
  const inline = argv.find((arg) => arg.startsWith("--only="));
  const flagIndex = argv.indexOf("--only");
  const raw = inline
    ? inline.slice("--only=".length)
    : flagIndex >= 0
      ? (argv[flagIndex + 1] ?? "")
      : null;
  return {
    only:
      raw === null
        ? available
        : raw
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
    force: argv.includes("--force"),
    writeLock: argv.includes("--write-lock"),
  };
}

/**
 * 取「跟随重定向之后的最终资产名」。Adoptium 的 `latest` 直链本身不含文件名，
 * 但重定向后的 URL 含（如 `OpenJDK21U-jre_aarch64_apple_hotspot_21.0.5_11.tar.gz`），
 * 写 lock 时把它记下来，「latest」就不再是悬空的。
 */
async function resolveFinalAssetName(url) {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow" });
    return basename(new URL(response.url).pathname) || null;
  } catch {
    return basename(new URL(url).pathname) || null;
  }
}

/**
 * Adoptium 的重定向尾段是一段 UUID，真正的发行物名在它的 assets JSON 里
 *（`binary.package.name`，与取 checksum 用的是同一份）。
 */
async function resolveChecksumAssetName(resolved) {
  if (!resolved.checksumUrl) return null;
  try {
    const assets = await (await fetch(resolved.checksumUrl)).json();
    return assets?.[0]?.binary?.package?.name ?? null;
  } catch {
    return null;
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function log(message) {
  console.log(`[runtimes] ${message}`);
}

/**
 * GitHub REST 的匿名额度按 IP 计，共享出口（公司/家宽/CI）很容易打满——403 限流时
 * 回落 `gh api`（认证额度独立，装了 gh CLI 的打包机可自愈）。仍失败则如实报因。
 */
async function fetchGithubReleaseJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "kenfutwork-packaging" },
  });
  if (response.ok) return response.json();
  const body = await response.text();
  if (response.status === 403 && /rate limit/i.test(body)) {
    const apiPath = url.replace("https://api.github.com/", "");
    // maxBuffer 放宽：python-build-standalone 的 release JSON 远超默认 1MB，
    // 超限时 spawnSync 返回 error + 空 stderr，会把真实原因吞成「gh 回落也失败」。
    const gh = spawnSync("gh", ["api", apiPath], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (gh.status === 0 && !gh.error) {
      log("GitHub 匿名额度已满，经 gh api（认证）获取成功。");
      return JSON.parse(gh.stdout);
    }
    throw new Error(
      `GitHub API 匿名额度已满，gh 回落也失败：${(gh.error?.message ?? gh.stderr ?? "").trim().slice(0, 160)}。稍后重试或 gh auth login。`,
    );
  }
  throw new Error(`GitHub API ${response.status}：${body.slice(0, 160)}`);
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
const GIT_RELEASE_API =
  "https://api.github.com/repos/git-for-windows/git/releases/latest";
/** MinGit（portable，免安装）：版本号随上游走，故按正则挑而不是硬编码。 */
const GIT_ASSET_PATTERN = /^MinGit-[\d.]+-64-bit\.zip$/;

/**
 * 在 git-for-windows 最新发布里取 MinGit（portable）zip 与其**官方 SHA-256**。
 *
 * 校验值不在独立资产里，而是写在**发布说明的表格**中（`<文件名> | <sha256>`），
 * 故这里解析 body——拿不到就 fail loud（与其余运行时的口径一致）。
 */
async function resolveMinGitAsset() {
  const release = await fetchGithubReleaseJson(GIT_RELEASE_API);
  const asset = (release?.assets ?? []).find((item) =>
    GIT_ASSET_PATTERN.test(item.name),
  );
  if (!asset) {
    throw new Error(
      `git 最新发布（${release?.tag_name ?? "?"}）里找不到 MinGit-*-64-bit.zip（fail loud）。`,
    );
  }
  const line = (release.body ?? "")
    .split("\n")
    .find((row) => row.trim().startsWith(`${asset.name} |`));
  const bodySha = line ? (line.split("|")[1] ?? "").trim() : "";
  if (!/^[0-9a-f]{64}$/.test(bodySha)) {
    throw new Error(
      `git 发布说明里找不到 ${asset.name} 的 sha256（fail loud）。`,
    );
  }
  log(`git 选中 ${asset.name}（发布 ${release.tag_name}）`);
  return {
    url: asset.browser_download_url,
    bodySha,
    fileName: asset.name,
  };
}

/**
 * 在 portable-standalone 最新发布里挑 `cpython-<series>.<patch>+<build>-<平台三元组>-install_only.tar.gz`
 * 中补丁号最大的那个（发布里的补丁号随上游走，硬编码某个补丁号会因上游发版而失效）。
 * 平台三元组由调用方按打包目标给（win=x86_64-pc-windows-msvc / mac=aarch64-apple-darwin）。
 */
async function resolvePythonAsset(series, platformTriple) {
  const release = await fetchGithubReleaseJson(PYTHON_RELEASE_API);
  const assets = release?.assets ?? [];
  const pattern = new RegExp(
    `^cpython-${series.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)\\+\\d+-${platformTriple.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-install_only\\.tar\\.gz$`,
  );
  const matched = assets.filter((item) => pattern.test(item.name ?? ""));
  const chosen = matched.sort(
    (a, b) => Number(pattern.exec(b.name)[1]) - Number(pattern.exec(a.name)[1]),
  )[0];
  const sumsAsset = assets.find((item) => item.name === "SHA256SUMS");
  if (!chosen || !sumsAsset) {
    throw new Error(
      `portable-standalone 发布（${release?.tag_name ?? "?"}）里找不到 python ${series}.x 的 ${platformTriple} 资产或 SHA256SUMS（fail loud）。`,
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

/** 在 uv 最新发布里取指定平台的 zip 与其 `.sha256` 校验文件。 */
async function resolveUvAsset(assetName) {
  const release = await fetchGithubReleaseJson(UV_RELEASE_API);
  const assets = release?.assets ?? [];
  const asset = assets.find((item) => item.name === assetName);
  const sums = assets.find((item) => item.name === `${assetName}.sha256`);
  if (!asset || !sums) {
    throw new Error(
      `uv 最新发布（${release?.tag_name ?? "?"}）里找不到 ${assetName} 或其 .sha256（fail loud）。`,
    );
  }
  log(`uv 选中 ${asset.name}（发布 ${release.tag_name}）`);
  return {
    url: asset.browser_download_url,
    rawShaUrl: sums.browser_download_url,
    fileName: asset.name,
  };
}

/**
 * 带有限重试的下载。GitHub 对象存储与发布 API 偶发 5xx / 403 限流 / 连接重置，一次网络
 * 抖动就让整条十几分钟的出包链变红不划算，且红得看不出原因。
 * 只重试「传输层」失败；内容问题（校验值不符、锁文件不匹配）由调用方判定，绝不重试。
 * 次数与退避是构建期常量，不是运行期限额，故不进治理表（AGENTS.md「运行时可调数值」一节）。
 */
const DOWNLOAD_ATTEMPTS = 3;

async function fetchBytesWithRetry(url) {
  let last = "";
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    let retryable = true;
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      last = `HTTP ${response.status}`;
      // 4xx（除 403/429 限流）说明 URL 本身错了，重试没有意义
      retryable =
        response.status >= 500 ||
        response.status === 403 ||
        response.status === 429;
    } catch (error) {
      last = error.message;
    }
    if (!retryable || attempt === DOWNLOAD_ATTEMPTS) break;
    const waitMs = 2000 * attempt;
    log(
      `第 ${attempt} 次取 ${basename(url)} 失败（${last}），${waitMs}ms 后重试…`,
    );
    await new Promise((done) => setTimeout(done, waitMs));
  }
  throw new Error(`${basename(url)} 取回失败：${last}（URL：${url}）`);
}

/** 取官方校验值：SHASUMS 文件按文件名查行，Adoptium 则读 assets JSON 的 checksum。 */
async function resolveExpectedSha(resolved, url) {
  // 校验值直接来自发布说明的表格（git-for-windows 的 MinGit 就是这么发布的）
  if (resolved.bodySha) {
    return resolved.bodySha;
  }
  if (resolved.sumsUrl) {
    const sums = (await fetchBytesWithRetry(resolved.sumsUrl)).toString("utf8");
    const fileName = resolved.fileName ?? basename(url);
    const line = sums.split("\n").find((row) => row.trim().endsWith(fileName));
    return line ? (line.trim().split(/\s+/)[0] ?? null) : null;
  }
  // 逐资产校验文件（uv 的 `<asset>.sha256`：内容就是哈希，或「哈希 + 文件名」）
  if (resolved.rawShaUrl) {
    const text = (await fetchBytesWithRetry(resolved.rawShaUrl))
      .toString("utf8")
      .trim();
    return text.split(/\s+/)[0] ?? null;
  }
  if (resolved.checksumUrl) {
    const assets = JSON.parse(
      (await fetchBytesWithRetry(resolved.checksumUrl)).toString("utf8"),
    );
    return assets?.[0]?.binary?.package?.checksum ?? null;
  }
  return null;
}

async function fetchWithSha(spec, { force, lock }) {
  const targetDir = join(RUNTIME_DIR, spec.name);
  const entry = lockEntryFor(lock, TARGET, spec.name);
  if (!force && existsSync(join(targetDir, spec.probe))) {
    log(
      entry
        ? `${spec.name} 已存在，跳过：${targetDir}（lock 要求 ${entry.fileName ?? entry.sha256?.slice(0, 12)}…；重新锁定后需 --force 重下）`
        : `${spec.name} 已存在，跳过（--force 可重下）：${targetDir}`,
    );
    return;
  }

  // 锁里有「确切 URL + sha256」时按**锁**下载，不再解析 latest：上游每发一版（uv
  // 0.12.24→0.13.0、python-build-standalone 20261003→20261009 都真实发生过）都会把
  // 出包链判红，而那既不是代码问题也不是可复现构建。官方校验值的抓取留给 --write-lock
  // 与「锁里没有该项」的路径；日常构建只信仓库里这条已评审过的 URL+哈希。
  const pinned = entry?.url && entry?.sha256 ? entry : null;
  const resolved = pinned ?? (await spec.resolve(spec.version ?? spec.series));
  const nameVerdict = assertLockAssetName({
    entry,
    fileName: resolved.fileName ?? null,
    name: spec.name,
    target: TARGET,
  });
  if (!nameVerdict.ok) {
    throw new Error(nameVerdict.reason);
  }
  const url = resolved.url;
  log(
    pinned
      ? `${spec.name} 按锁下载：${url}`
      : `${spec.name} 下载（解析 latest）：${url}`,
  );
  const buffer = await fetchBytesWithRetry(url);
  const digest = sha256(buffer);

  if (!pinned) {
    const expected = await resolveExpectedSha(resolved, url);
    if (!expected) {
      throw new Error(`${spec.name} 拿不到官方校验值，拒绝安装（fail loud）。`);
    }
    if (expected !== digest) {
      throw new Error(
        `${spec.name} 校验失败：期望 ${expected}，实际 ${digest}（若官方更新了版本，请同步更新脚本里的版本/哈希）。`,
      );
    }
  }
  const shaVerdict = assertLockSha({
    entry,
    sha256: digest,
    name: spec.name,
    target: TARGET,
  });
  if (!shaVerdict.ok) {
    throw new Error(shaVerdict.reason);
  }
  if (shaVerdict.reason) {
    log(shaVerdict.reason);
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

/**
 * 写 lock：只解析、只取官方校验值，**不下载压缩包**。
 * 另一台打包机（另一目标平台）那一节保持原样——lock 是两份目标平台的并集。
 */
async function writeLock(specs) {
  const lock = readRuntimeLock(ROOT);
  const entries = {};
  for (const [name, spec] of Object.entries(specs)) {
    const resolved = await spec.resolve(spec.version ?? spec.series);
    const digest = await resolveExpectedSha(resolved, resolved.url);
    if (!digest) {
      throw new Error(`${name} 拿不到官方校验值，无法写 lock（fail loud）。`);
    }
    const fileName =
      resolved.fileName ??
      (await resolveChecksumAssetName(resolved)) ??
      (await resolveFinalAssetName(resolved.url));
    entries[name] = buildLockEntry({
      version: spec.version ?? spec.series,
      fileName,
      sha256: digest,
      url: resolved.url,
    });
    log(
      `锁定 ${name}：${fileName ?? "（最终名未知）"} sha256=${digest.slice(0, 12)}…`,
    );
  }
  const next = mergeLockTargets(lock, TARGET, entries);
  const file = join(ROOT, LOCK_FILE_NAME);
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  log(`已写 ${relative(ROOT, file)}（本次只覆盖 ${TARGET} 那一节）。`);
}

async function main() {
  const specs = SPECS[TARGET];
  if (!specs) {
    throw new Error(
      `当前平台 ${TARGET} 没有可用的运行时资产清单（fail loud）。目前支持：${Object.keys(SPECS).join("、")}。`,
    );
  }
  const {
    only,
    force,
    writeLock: shouldWrite,
  } = parseArgs(process.argv.slice(2), Object.keys(specs));
  if (shouldWrite) {
    await writeLock(specs);
    return;
  }
  const lock = readRuntimeLock(ROOT);
  if (!lock) {
    log(
      `未发现 ${LOCK_FILE_NAME}：按「最新发布」解析（出包不可复现）。要固化就跑 --write-lock。`,
    );
  }
  const selected = Object.entries(specs).filter(([name]) =>
    only.includes(name),
  );
  if (selected.length === 0) {
    throw new Error(`--only 里没有可识别的运行时：${only.join(",")}`);
  }
  for (const [name, spec] of selected) {
    await fetchWithSha({ name, ...spec }, { force, lock });
  }
  log(`完成（目标 ${TARGET}）。运行时目录：${RUNTIME_DIR}`);
  log(
    "打包时 scripts/package-win.mjs / package-mac.mjs 会把它拷进发布包的 <exeDir>/runtime/。",
  );
}

// 被 import（测试 parseArgs 这类纯函数）时不触发下载；只有作为入口执行才跑主流程。
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(`[runtimes] 失败：${error.message}`);
    process.exitCode = 1;
  });
}
