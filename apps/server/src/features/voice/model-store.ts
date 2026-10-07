/**
 * 内置模型的按需下载 / 删除（规划 §5）。
 *
 * 三条不可妥协的口径：
 * 1. **未选择 = 不下载**：这里只在被显式调用时动手，不做任何预取；
 * 2. **校验和不匹配即失败，且不留半截文件**：全程写进 `<模型目录>.staging`，
 *    逐个文件校验通过后整目录 rename 就位（与 `scripts/fetch-runtimes.mjs` 同做法）；
 * 3. **失败可读 + 可重试**：失败原因留在状态里（含手动放置路径），重试即重下。
 *
 * 取消是**协作式**的：走 AbortController，且取消与失败一样清干净 staging 目录。
 */

import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveBuiltinModelDir } from "./builtin-models.js";
import {
  BUILTIN_VOICE_MODELS,
  type BuiltinVoiceModelSpec,
  builtinModelSizeBytes,
} from "./catalog.js";

/** 下载状态（与 `voice-contracts` 的 download 字段同形）。 */
export interface VoiceModelDownloadState {
  state: "ready" | "missing" | "downloading";
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
}

export class VoiceModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceModelError";
  }
}

export interface VoiceModelStoreDeps {
  modelsRoot: string;
  /**
   * 可用模型表（缺省 = 内置目录表）。下载**只认这张表里的 id 与 URL**：接口不收调用方
   * 传进来的 URL，也就没有「任意 URL 下载器」（SSRF 与磁盘填充的口子）。
   * 单测传一张小体积假模型表，避免真下 228MB。
   */
  specs?: readonly BuiltinVoiceModelSpec[];
  /** 测试注入：默认全局 fetch。 */
  fetchFn?: typeof fetch;
  /** 测试注入：校验用哈希（默认 sha256）。 */
  hashFn?: (bytes: Uint8Array) => string;
  onProgress?: (modelId: string) => void;
}

export interface VoiceModelStore {
  /** 某个内置模型的当前状态（含未开始/失败留痕）。 */
  getState(modelId: string): Promise<VoiceModelDownloadState>;
  /** 开始下载（已在下载中返回当前状态，不重复起任务）。 */
  start(modelId: string): Promise<VoiceModelDownloadState>;
  /** 取消下载（协作式；未在下载中则无操作）。 */
  cancel(modelId: string): void;
  /** 删除已下载的模型文件（下载中先取消）。 */
  remove(modelId: string): Promise<void>;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createVoiceModelStore(
  deps: VoiceModelStoreDeps,
): VoiceModelStore {
  const specs = deps.specs ?? BUILTIN_VOICE_MODELS;
  const hashFn = deps.hashFn ?? sha256Hex;
  const doFetch = deps.fetchFn ?? fetch;
  /** 在途下载（含进度）与上次失败原因。 */
  const inFlight = new Map<
    string,
    { controller: AbortController; downloadedBytes: number; error?: undefined }
  >();
  const failures = new Map<string, string>();

  function stagingDir(modelId: string): string {
    return join(deps.modelsRoot, `${modelId}.staging`);
  }

  function modelDir(modelId: string): string {
    return resolveBuiltinModelDir(deps.modelsRoot, modelId);
  }

  async function requireSpec(modelId: string): Promise<BuiltinVoiceModelSpec> {
    const spec = specs.find((model) => model.id === modelId);
    if (!spec) {
      // 只认表里的 id：不做「任意 URL 下载器」（那是 SSRF 与磁盘填充的口子）
      throw new VoiceModelError(`未知的内置模型：${modelId}`);
    }
    return spec;
  }

  /** 文件是否已就位且大小一致（校验和不在此处重算：228MB 每次列目录都哈希不可接受）。 */
  async function allFilesPresent(
    spec: BuiltinVoiceModelSpec,
  ): Promise<boolean> {
    const dir = modelDir(spec.id);
    for (const file of spec.files) {
      try {
        const info = await stat(join(dir, file.path));
        if (!info.isFile() || info.size !== file.sizeBytes) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  async function downloadFile(
    spec: BuiltinVoiceModelSpec,
    file: BuiltinVoiceModelSpec["files"][number],
    signal: AbortSignal,
    onBytes: (delta: number) => void,
  ): Promise<void> {
    const response = await doFetch(file.url, { redirect: "follow", signal });
    if (!response.ok) {
      throw new VoiceModelError(
        `下载失败（HTTP ${response.status}）：${file.url}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    onBytes(bytes.byteLength);
    if (bytes.byteLength !== file.sizeBytes) {
      throw new VoiceModelError(
        `文件大小不符：${file.path} 期望 ${file.sizeBytes} 字节，实际 ${bytes.byteLength}`,
      );
    }
    const digest = hashFn(bytes);
    if (digest !== file.sha256) {
      throw new VoiceModelError(
        `校验和不匹配：${file.path} 期望 ${file.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…（文件可能被上游替换或下载损坏，已放弃且未留半截文件）`,
      );
    }
    const target = join(stagingDir(spec.id), file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  /** 取消是**用户意图**，不是错误：单独一类，失败留痕时不当成失败原因展示。 */
  class DownloadCancelled extends Error {
    constructor() {
      super("下载已取消");
      this.name = "DownloadCancelled";
    }
  }

  async function runDownload(spec: BuiltinVoiceModelSpec): Promise<void> {
    const entry = inFlight.get(spec.id);
    if (!entry) return;
    const signal = entry.controller.signal;
    /** 文件之间与就位之前都要看一次：只靠 fetch 的 abort 会漏掉「刚好在切换文件时取消」。 */
    const throwIfAborted = () => {
      if (signal.aborted) {
        throw new DownloadCancelled();
      }
    };
    try {
      await rm(stagingDir(spec.id), { recursive: true, force: true });
      await mkdir(stagingDir(spec.id), { recursive: true });
      for (const file of spec.files) {
        throwIfAborted();
        await downloadFile(spec, file, signal, (delta) => {
          entry.downloadedBytes += delta;
          deps.onProgress?.(spec.id);
        });
      }
      // 全部文件校验通过才整目录就位：中途失败时模型目录里不会出现半个模型
      throwIfAborted();
      await rm(modelDir(spec.id), { recursive: true, force: true });
      await rename(stagingDir(spec.id), modelDir(spec.id));
      failures.delete(spec.id);
    } catch (error) {
      if (error instanceof DownloadCancelled || signal.aborted) {
        // 取消不算失败：不留「失败原因」误导用户，状态回到未下载
        failures.delete(spec.id);
      } else {
        failures.set(
          spec.id,
          // 失败信息里带上手动放置路径：下载不通（公司网络/镜像）时这是唯一的出路
          `${error instanceof Error ? error.message : String(error)}（也可手动把模型文件放到 ${modelDir(spec.id)}）`,
        );
      }
    } finally {
      inFlight.delete(spec.id);
      // 失败与取消都清干净 staging（成功时上面已 rename 走，force 不报错）
      await rm(stagingDir(spec.id), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  return {
    async getState(modelId) {
      const spec = await requireSpec(modelId);
      const active = inFlight.get(modelId);
      const totalBytes = builtinModelSizeBytes(spec);
      const failure = failures.get(modelId);
      if (active) {
        return {
          state: "downloading",
          downloadedBytes: active.downloadedBytes,
          totalBytes,
        };
      }
      const ready = await allFilesPresent(spec);
      return {
        state: ready ? "ready" : "missing",
        downloadedBytes: ready ? totalBytes : 0,
        totalBytes,
        ...(failure ? { error: failure } : {}),
      };
    },

    async start(modelId) {
      const spec = await requireSpec(modelId);
      if (!inFlight.has(modelId)) {
        failures.delete(modelId);
        inFlight.set(modelId, {
          controller: new AbortController(),
          downloadedBytes: 0,
        });
        // 不 await：接口立刻回 202 + 状态，进度由前端轮询
        void runDownload(spec);
      }
      return this.getState(modelId);
    },

    cancel(modelId) {
      inFlight.get(modelId)?.controller.abort();
    },

    async remove(modelId) {
      const spec = await requireSpec(modelId);
      inFlight.get(modelId)?.controller.abort();
      await rm(modelDir(spec.id), { recursive: true, force: true });
      await rm(stagingDir(spec.id), { recursive: true, force: true });
      failures.delete(spec.id);
    },
  };
}
