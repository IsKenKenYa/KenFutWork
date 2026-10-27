import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type {
  WorkEditorInstallStatus,
  WorkEditorPinnedRelease,
} from "@kenfutwork/shared";
import { unzipSync } from "fflate";

/**
 * 编辑器扩展包按需下载（WD-3，范式同 `scripts/fetch-runtimes.mjs` / flow 引擎安装）：
 * 官方锚定值（版本/字节数/sha256）→ 下载 → 逐项核验 → 解压剥顶层目录 →
 * 原子落位（staging + rename，不留半截）→ 幂等（落位标记 sha256 一致即跳过）。
 *
 * 状态机是**内存单例**（与 flow 同口径）：重启归零，`installed` 由数据目录
 * 事实重新计算（路由层 existsSync），不丢真相。落位标记
 * `.kenfutwork-install.json` 记录版本与校验和，供幂等判断与后续升级对比。
 */

const INSTALL_MARKER = ".kenfutwork-install.json";
const LOG_TAIL_LIMIT = 20;

export type WorkEditorInstallOptions = {
  editorsDir: string;
  editorId: string;
  pinned: WorkEditorPinnedRelease;
};

const snapshots = new Map<string, WorkEditorInstallStatus>();
const inflight = new Map<string, Promise<void>>();

export function getWorkEditorInstallSnapshot(
  editorId: string,
): WorkEditorInstallStatus {
  return snapshots.get(editorId) ?? { state: "idle", logTail: [] };
}

export function getWorkEditorInstallSnapshots(): Record<
  string,
  WorkEditorInstallStatus
> {
  return Object.fromEntries(snapshots);
}

function pushLog(editorId: string, line: string): void {
  const current = getWorkEditorInstallSnapshot(editorId);
  snapshots.set(editorId, {
    ...current,
    logTail: [...current.logTail, line].slice(-LOG_TAIL_LIMIT),
  });
}

function settle(
  editorId: string,
  patch: Partial<WorkEditorInstallStatus>,
): void {
  snapshots.set(editorId, {
    ...getWorkEditorInstallSnapshot(editorId),
    ...patch,
  });
}

/**
 * 发起安装（幂等）：同编辑器已在装 → 返回 false（路由回 409，轮询状态即可）；
 * 落位标记 sha256 与锚定一致 → 直接 ready（不重复下载）。
 */
export function startWorkEditorInstall(options: WorkEditorInstallOptions): {
  started: boolean;
  snapshot: WorkEditorInstallStatus;
} {
  const current = getWorkEditorInstallSnapshot(options.editorId);
  if (inflight.has(options.editorId))
    return { started: false, snapshot: current };
  snapshots.set(options.editorId, {
    state: "installing",
    logTail: [
      `开始下载 ${options.pinned.asset}（${Math.max(1, Math.round(options.pinned.bytes / 1024 / 1024))}MB）`,
    ],
    startedAt: new Date().toISOString(),
  });
  const task = runInstall(options)
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : String(error ?? "未知错误");
      settle(options.editorId, {
        state: "error",
        error: message,
      });
      pushLog(options.editorId, `安装失败：${message}`);
    })
    .finally(() => {
      inflight.delete(options.editorId);
    });
  inflight.set(options.editorId, task);
  return {
    started: true,
    snapshot: getWorkEditorInstallSnapshot(options.editorId),
  };
}

async function runInstall(options: WorkEditorInstallOptions): Promise<void> {
  const { editorsDir, editorId, pinned } = options;
  const finalDir = join(editorsDir, editorId);

  await mkdir(editorsDir, { recursive: true });
  const existingSha = await readMarkerSha256(finalDir);
  if (existingSha === pinned.sha256) {
    settle(editorId, { state: "ready" });
    pushLog(editorId, `已落位（v${pinned.version}），跳过下载`);
    return;
  }

  pushLog(editorId, "下载中…");
  // 120s 是一次性兜底常量（非运行可调治理项）：个位数 MB 发行包外网下载的
  // 宽裕上限，与 flow 安装轮询的固定兜底同口径。
  const response = await fetch(pinned.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(`下载失败：HTTP ${response.status}（${pinned.url}）`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length !== pinned.bytes)
    throw new Error(
      `下载体积不符：实际 ${body.length} 字节，锚定发布 ${pinned.bytes} 字节。`,
    );
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (sha256 !== pinned.sha256)
    throw new Error("校验和不匹配：下载内容与锚定发布不一致，已丢弃。");
  pushLog(editorId, "校验和通过，解压落位中…");

  const staging = join(
    await mkdtemp(join(tmpdir(), "work-editor-")),
    "payload",
  );
  const trash = `${finalDir}.trash-${Date.now()}`;
  try {
    await extractZipPayload(body, staging);
    await writeFile(
      join(staging, INSTALL_MARKER),
      JSON.stringify({
        editorId,
        version: pinned.version,
        sha256,
        installedAt: new Date().toISOString(),
      }),
    );
    if (existsSync(finalDir)) await rename(finalDir, trash);
    await rename(staging, finalDir);
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (existsSync(trash)) await rm(trash, { recursive: true, force: true });
  }
  settle(editorId, { state: "ready" });
  pushLog(editorId, `已落位（v${pinned.version}）`);
}

/** zip 内单顶层目录是 craft 发行包的固定结构；剥掉后写平（index.html 在编辑器目录根）。 */
async function extractZipPayload(
  zip: Buffer,
  targetDir: string,
): Promise<void> {
  const entries = unzipSync(zip);
  const names = Object.keys(entries).filter(
    (name) => name.length > 0 && !name.endsWith("/"),
  );
  if (names.length === 0) throw new Error("发行包为空，已丢弃。");
  const tops = new Set(names.map((name) => name.split("/")[0]));
  const prefix = tops.size === 1 ? `${[...tops][0]}/` : "";
  const writes: Array<Promise<void>> = [];
  for (const name of names) {
    const rel = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (
      rel.length === 0 ||
      rel.startsWith("/") ||
      rel.includes("..") ||
      rel.includes("\\")
    )
      throw new Error(`发行包含非法路径 ${name}，已丢弃。`);
    const target = join(targetDir, rel);
    if (!target.startsWith(targetDir + sep))
      throw new Error(`发行包含越界路径 ${name}，已丢弃。`);
    const data = entries[name];
    if (!data) throw new Error(`发行包条目缺失 ${name}，已丢弃。`);
    writes.push(
      mkdir(dirname(target), { recursive: true }).then(() =>
        writeFile(target, data),
      ),
    );
  }
  await Promise.all(writes);
}

async function readMarkerSha256(editorDir: string): Promise<string | null> {
  if (!existsSync(editorDir)) return null;
  try {
    const marker = JSON.parse(
      await readFile(join(editorDir, INSTALL_MARKER), "utf8"),
    ) as { sha256?: unknown };
    return typeof marker.sha256 === "string" ? marker.sha256 : null;
  } catch {
    return null;
  }
}
