#!/usr/bin/env node
/**
 * 出包清单 `dist-manifest.json`：把「这个包怎么来的、签没签、里面哪些二进制没封印」写成
 * 一等公民，debug 发版不再靠人回忆。
 *
 * 为什么需要它（三条都是踩过的坑）：
 *  1. `codesign --verify --deep` 通过，**证明不了** `Contents/Resources` 下那批散装 Mach-O
 *     已封印（实测 `pg/` 330 个、`runtime/` 61 个；`--deep` 早被 Apple 标注不可靠）。
 *     只有逐个 verify 才有读数，而这正是将来公证会被杀的位置。
 *  2. 签名状态必须如实标注：临时签名就是 `adhoc`、没签就是 `unsigned`，不许冒称证书完成
 *     （口径见 docs/日志.md 的「无有效 Developer ID 身份，不冒称证书/公证完成」）。
 *  3. 构建宿主 node / SEA 宿主 / 随包 runtime 版本此前无处记账，同一 commit 在两台打包机
 *     出的包无法对账（`package-win.mjs` 的 SEA 宿主就是构建机的 node）。
 *
 * 用法（由 collect-bundle.mjs 在收完产物后调用）：writeDistManifest({ root, artifacts, ... })
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

/** Mach-O 魔数（小端/大端两种读法都要比，fat binary 另算）。 */
const MACHO_MAGICS = new Set([
  0xfeedface, // MH_MAGIC（32 位）
  0xfeedfacf, // MH_MAGIC_64
  0xcafebabe, // FAT_MAGIC
  0xcafebabf, // FAT_MAGIC_64
]);

/** 读前 4 字节判断是否 Mach-O（不依赖 `file` 命令，跨平台一致）。 */
export function isMachOHeader(header) {
  if (header.length < 4) return false;
  const le = header.readUInt32LE(0);
  const be = header.readUInt32BE(0);
  return MACHO_MAGICS.has(le) || MACHO_MAGICS.has(be);
}

/** 递归收集目录里的 Mach-O 文件（软链按真实路径去重——`pg/lib` 就靠软链存活）。 */
export function findMachOFiles(dir) {
  const seen = new Set();
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      let real;
      try {
        real = realpathSync.native(path);
      } catch {
        real = path;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      let fd;
      try {
        fd = openSync(path, "r");
        const header = Buffer.alloc(4);
        const bytes = readSync(fd, header, 0, 4, 0);
        if (bytes === 4 && isMachOHeader(header.subarray(0, bytes))) {
          found.push(path);
        }
      } catch {
        // 读不动的条目（权限/坏链）不算 Mach-O，交由后续封印计数暴露
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

/**
 * 逐个 `codesign --verify --strict`：返回总数与失败清单（清单截到 25 条，计数不截）。
 * 只在 darwin 有意义；其它平台返回 null，让 manifest 如实缺项而不是填个假的零。
 */
export function verifyMachOFiles(files, codesign = "/usr/bin/codesign") {
  const failed = [];
  for (const file of files) {
    const result = spawnSync(codesign, ["--verify", "--strict", file], {
      stdio: "pipe",
    });
    if (result.status !== 0) failed.push(file);
  }
  return {
    total: files.length,
    failedTotal: failed.length,
    failedSample: failed.slice(0, 25),
  };
}

/** 把 `codesign -dv --verbose=2` 的输出归类成如实的签名状态（不猜、不含糊）。 */
export function classifyCodesignDisplay(output) {
  const text = String(output ?? "");
  if (/Signature=adhoc/.test(text)) return "adhoc";
  if (/Authority=Developer ID Application/.test(text)) return "developer-id";
  if (/not signed at all/.test(text)) return "unsigned";
  if (
    /Signature=.*Apple/.test(text) ||
    /Authority=Apple Development/.test(text)
  )
    return "apple-development";
  if (text.trim() === "") return "unknown";
  return "unknown";
}

/** Windows Authenticode 状态归类（PowerShell `Get-AuthenticodeSignature` 的 Status）。 */
export function classifyAuthenticode(status) {
  const value = String(status ?? "").trim();
  if (/^Valid$/i.test(value)) return "authenticode-valid";
  if (/^NotSigned$/i.test(value)) return "unsigned";
  if (value === "") return "unknown";
  return `authenticode-${value.toLowerCase()}`;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 组装清单。**纯函数**：所有外部读数由调用方注入，便于用夹具测试而不必真出一个安装包。
 * `signing.status` 未知时一律落 `unknown`，不给「看起来像签好了」的默认值。
 */
export function buildDistManifest(input) {
  const {
    version,
    platform,
    commit = null,
    ref = null,
    artifacts = [],
    root = null,
    signing = {},
    build = {},
    runtimeVersions = null,
    macos = null,
    generatedAt = new Date().toISOString(),
  } = input;

  return {
    product: "KenFutWork",
    version: version ?? null,
    platform: platform ?? null,
    arch: process.arch,
    commit,
    ref,
    generatedAt,
    build: {
      node: build.node ?? process.version,
      rustc: build.rustc ?? null,
      tauriCli: build.tauriCli ?? null,
    },
    runtimeVersions,
    signing: {
      status: signing.status ?? "unknown",
      provider: signing.provider ?? "none",
    },
    macos,
    artifacts: artifacts
      .filter((file) => existsSync(file) && lstatSync(file).isFile())
      .map((file) => ({
        file: root ? relative(root, file) || file : file,
        size: statSync(file).size,
        sha256: sha256File(file),
      })),
  };
}

/** 写清单到仓库根，并回显一行读数（出包日志里要能一眼看到签名状态与未封印计数）。 */
export function writeDistManifest(root, manifest) {
  const file = join(root, "dist-manifest.json");
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  const macho = manifest.macos;
  console.log(
    `[manifest] ${manifest.version} ${manifest.platform}/${manifest.arch} ` +
      `签名=${manifest.signing.status}` +
      (macho ? ` 未封印 Mach-O=${macho.failedTotal}/${macho.total}` : "") +
      ` 产物=${manifest.artifacts.map((a) => a.file).join("、") || "无"}`,
  );
  console.log(`[manifest] 清单已写入：${file}`);
  return file;
}

/** 读 `.nvmrc` 之外的构建读数：rustc 与 @tauri-apps/cli 版本（拿不到就 null，不编）。 */
export function readBuildTooling(root) {
  let rustc = null;
  try {
    rustc = execFileSync("rustc", ["-V"], { encoding: "utf8" }).trim();
  } catch {
    rustc = null;
  }
  let tauriCli = null;
  const cliManifest = join(
    root,
    "apps/desktop/node_modules/@tauri-apps/cli/package.json",
  );
  if (existsSync(cliManifest)) {
    tauriCli = JSON.parse(readFileSync(cliManifest, "utf8")).version ?? null;
  }
  return { node: process.version, rustc, tauriCli };
}
