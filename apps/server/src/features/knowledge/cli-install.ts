/**
 * SAG CLI 三级探测（KB-5，规划 §3.3）：
 * ① 复用本机已装 `sag`（PATH）② 未装则按需下载钉版本 + 校验和（npm tarball）
 * ③ 两者都失败 → 显式 missing + 离线安装指引（不静默关闭功能）。
 *
 * 下载范式照 `features/voice/model-store.ts` / `scripts/fetch-runtimes.mjs`：
 * staging 目录写入 → sha512 校验 → 原子 rename 就位；失败清 staging、不留半截文件。
 * 只下载注册表里钉死的 URL（`SAG_CLI_TARBALL`），不收调用方传 URL（无任意下载面）。
 *
 * 复用优先的实测依据：上游 CLI 与桌面端共享 `sag.sqlite`、配置与忽略规则，
 * 已装桌面端的用户不该被逼着再下一份、再建一次库。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Parser as TarParser } from "tar";

import {
  isSagCliPlatformSupported,
  SAG_CLI_INTEGRITY,
  SAG_CLI_TARBALL,
  SAG_CLI_VERSION,
} from "./sag-cli-contract.js";

export type SagCliResolution =
  | { kind: "system"; binary: string }
  | { kind: "managed"; binary: string }
  | { kind: "missing"; reason: string; guidance: string }
  | { kind: "unsupported_platform"; reason: string };

export interface SagCliInstallerDeps {
  /** 应用数据根：自带 CLI 落 `<dataDir>/knowledge/sag/<version>-<target>/`。 */
  dataDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** 测试注入：默认 `execFile(binary, ["--build-info"])`。 */
  probe?: (binary: string) => Promise<boolean>;
  /** 测试注入：默认全局 fetch。 */
  fetchFn?: typeof fetch;
  /** 测试注入：默认钉版本 tarball 与校验和（生产不得覆盖成任意下载面）。 */
  tarballUrl?: string;
  integrity?: string;
}

export interface SagCliInstaller {
  /** 只读探测（不下载）：系统 CLI → 已落位自带 CLI → missing。 */
  inspect(): Promise<SagCliResolution>;
  /** 按需解析：inspect 失败则在支持平台上尝试下载一次；成功结果缓存。 */
  resolve(): Promise<SagCliResolution>;
}

const OFFLINE_GUIDANCE =
  "离线安装：npm install -g @zleap-ai/sag@0.1.8（仅 Windows x64 / macOS Apple Silicon），或保持联网由插件自动下载。";

/** 系统 CLI 探测的负结果冷却：面板每 8s 心跳，避免每次轮询都 spawn 一次。 */
const SYSTEM_PROBE_RETRY_MS = 60_000;
/** 钉版本 tarball 下载的一次性预算（联网慢时给足；不属用户可调运行档）。 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

function targetOf(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`;
}

function binaryNameOf(platform: NodeJS.Platform): string {
  return platform === "win32" ? "sag.exe" : "sag";
}

/** `sag --build-info` 无条件输出 JSON（M0 实采），比 `sag config` 更稳。 */
function defaultProbe(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ["--build-info"],
      {
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) return resolve(false);
        try {
          const info = JSON.parse(String(stdout)) as { version?: unknown };
          resolve(typeof info.version === "string" && info.version.length > 0);
        } catch {
          resolve(false);
        }
      },
    );
  });
}

interface TarballEntries {
  binary?: Buffer;
  license?: Buffer;
}

/** 只收集目标二进制与许可文本；npm tarball 的 `package/` 前缀自动剥离。 */
function readTarballEntries(
  buffer: Buffer,
  wantedBinarySuffix: string,
  binaryName: string,
): Promise<TarballEntries> {
  return new Promise((resolve, reject) => {
    const entries: TarballEntries = {};
    const parser = new TarParser({
      onReadEntry(entry) {
        if (entry.type !== "File") {
          entry.resume();
          return;
        }
        const normalized = entry.path.replace(/^package\//u, "");
        const wanted =
          normalized === `native/${wantedBinarySuffix}/${binaryName}` ||
          normalized === `native/${wantedBinarySuffix}`;
        const isLicense = /^licen[cs]e(\.txt|\.md)?$/iu.test(normalized);
        if (!wanted && !isLicense) {
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => chunks.push(chunk));
        entry.on("end", () => {
          const content = Buffer.concat(chunks);
          if (wanted) entries.binary = content;
          if (isLicense) entries.license = content;
        });
        entry.on("error", () => entry.resume());
      },
    });
    parser.on("error", (error: Error) => reject(error));
    parser.on("end", () => resolve(entries));
    parser.write(buffer);
    parser.end();
  });
}

export function createSagCliInstaller(
  deps: SagCliInstallerDeps,
): SagCliInstaller {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const supported = isSagCliPlatformSupported(platform, arch);
  const probe = deps.probe ?? defaultProbe;
  const doFetch = deps.fetchFn ?? fetch;
  const tarballUrl = deps.tarballUrl ?? SAG_CLI_TARBALL;
  const expectedIntegrity = deps.integrity ?? SAG_CLI_INTEGRITY;
  const target = targetOf(platform, arch);
  const binaryName = binaryNameOf(platform);
  const managedDir = join(
    deps.dataDir,
    "knowledge",
    "sag",
    `${SAG_CLI_VERSION}-${target}`,
  );
  const managedBinary = join(managedDir, binaryName);

  /** 成功结果永久缓存；系统探测失败只冷却一段时间（用户可能刚装好）。 */
  let resolved: SagCliResolution | undefined;
  let systemFailedAt: number | undefined;
  let downloading: Promise<SagCliResolution> | undefined;

  async function probeSystem(): Promise<boolean> {
    if (
      systemFailedAt !== undefined &&
      Date.now() - systemFailedAt < SYSTEM_PROBE_RETRY_MS
    ) {
      return false;
    }
    const ok = await probe("sag");
    if (!ok) systemFailedAt = Date.now();
    return ok;
  }

  async function probeManaged(): Promise<boolean> {
    try {
      const info = await stat(managedBinary);
      if (!info.isFile()) return false;
    } catch {
      return false;
    }
    return probe(managedBinary);
  }

  async function inspect(): Promise<SagCliResolution> {
    if (resolved) return resolved;
    if (!supported) {
      resolved = {
        kind: "unsupported_platform",
        reason:
          "当前平台没有 SAG CLI 原生二进制（仅 Windows x64 与 macOS Apple Silicon）。",
      };
      return resolved;
    }
    if (await probeSystem()) {
      resolved = { kind: "system", binary: "sag" };
      return resolved;
    }
    if (await probeManaged()) {
      resolved = { kind: "managed", binary: managedBinary };
      return resolved;
    }
    return {
      kind: "missing",
      reason: "未找到可用的 SAG CLI（PATH 与本机自带目录都没有）。",
      guidance: OFFLINE_GUIDANCE,
    };
  }

  async function download(): Promise<SagCliResolution> {
    const response = await doFetch(tarballUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`下载 SAG CLI 失败（HTTP ${response.status}）`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const digest = `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
    if (digest !== expectedIntegrity) {
      throw new Error("下载的 SAG CLI 校验和不匹配，已丢弃。");
    }
    const entries = await readTarballEntries(buffer, target, binaryName);
    if (!entries.binary) {
      throw new Error(`SAG CLI 包内缺少目标平台二进制（${target}）。`);
    }
    const staging = join(
      deps.dataDir,
      "knowledge",
      "sag",
      `.staging-${process.pid}-${Date.now()}`,
    );
    await mkdir(staging, { recursive: true });
    try {
      await writeFile(join(staging, binaryName), entries.binary, {
        mode: 0o755,
      });
      if (entries.license) {
        await writeFile(join(staging, "LICENSE"), entries.license);
      }
      await writeFile(
        join(staging, "install.json"),
        `${JSON.stringify(
          {
            version: SAG_CLI_VERSION,
            target,
            integrity: expectedIntegrity,
            installedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await chmod(join(staging, binaryName), 0o755).catch(() => undefined);
      await rm(managedDir, { recursive: true, force: true });
      await rename(staging, managedDir);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    if (!(await probeManaged())) {
      throw new Error("自带 SAG CLI 落位后无法执行（可能被杀软拦截）。");
    }
    return { kind: "managed", binary: managedBinary };
  }

  return {
    inspect,

    async resolve() {
      const inspected = await inspect();
      if (inspected.kind !== "missing") return inspected;
      if (!downloading) {
        downloading = download()
          .catch(
            (error): SagCliResolution => ({
              kind: "missing",
              reason: `自动下载 SAG CLI 失败：${
                error instanceof Error ? error.message : String(error)
              }`,
              guidance: OFFLINE_GUIDANCE,
            }),
          )
          .then((result) => {
            downloading = undefined;
            if (result.kind === "managed") resolved = result;
            return result;
          });
      }
      return downloading;
    },
  };
}
