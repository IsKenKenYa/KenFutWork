import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { SkillImportSourceKind } from "@kenfutwork/shared";
import {
  SkillImportSourceError,
  type SkillImportSourceLimits,
  withSourceDeadline,
} from "./import-source-support.js";

/**
 * 技能导入的暂存来源登记表。
 *
 * 用户给出 git 地址或上传 zip 后，服务端先把内容解到本机临时目录，
 * 扫描与导入都读这个目录。目录名随机，只能经实例内登记表按来源 id 访问；
 * 保留时长与数量上限来自实例设置，超出后删除最早暂存的来源。
 */

export interface SkillImportStagedSource {
  id: string;
  instanceId: string;
  kind: SkillImportSourceKind;
  /** 展示用名称：git 地址或 zip 文件名 */
  label: string;
  /** 解好的仓库快照或压缩包内容所在目录 */
  rootPath: string;
  /** 整棵临时目录（含 `.git` 与上传副本），释放时一并删除 */
  workDirectory: string;
  /** 稳定来源标识：git 地址 + 提交号，或压缩包内容摘要 */
  sourceKey: string;
  createdAt: number;
}

/** 每次操作时读一次保留策略：设置改了立刻生效，不缓存旧值。 */
export interface SkillImportStagingPolicy {
  ttlMs: number;
  maxSources: number;
}

export interface SkillImportSourceStager {
  stageGit(input: {
    instanceId: string;
    url: string;
    binary: string;
    limits: SkillImportSourceLimits;
  }): Promise<SkillImportStagedSource>;
  stageZip(input: {
    instanceId: string;
    fileName: string;
    stream: Readable;
    limits: SkillImportSourceLimits;
  }): Promise<SkillImportStagedSource>;
  /** 列出该实例尚在保留期内的来源（已过期的顺手清掉）。 */
  list(instanceId: string): Promise<SkillImportStagedSource[]>;
  /** 按 id 取来源；不是本实例的或已过期的一律当作不存在。 */
  find(
    instanceId: string,
    id: string,
  ): Promise<SkillImportStagedSource | undefined>;
  /** 释放一个来源；不存在时返回 false。 */
  release(instanceId: string, id: string): Promise<boolean>;
  /** 释放该实例的全部来源（关闭导入对话框时用）。 */
  releaseAll(instanceId: string): Promise<void>;
  /** 进程退出时清空全部暂存目录。 */
  dispose(): void;
}

export interface SkillImportStagingOptions {
  readPolicy: (instanceId: string) => Promise<SkillImportStagingPolicy>;
  /** 临时目录父目录；缺省系统临时目录，测试注入 `.scratch/` 下的目录。 */
  parentDirectory?: string;
  now?: () => number;
}

export function createSkillImportSourceStager(
  options: SkillImportStagingOptions,
): SkillImportSourceStager {
  const sources = new Map<string, SkillImportStagedSource>();
  const now = options.now ?? (() => Date.now());
  const parentDirectory = options.parentDirectory ?? tmpdir();

  const removeDirectory = (directory: string): void => {
    rmSync(directory, { recursive: true, force: true });
  };

  const dropExpired = async (): Promise<void> => {
    // 逐个实例读自己的保留策略：同一个服务端可能只托管一个实例，
    // 但设置按实例分档，不能拿任意一个实例的值套到别人身上。
    for (const instanceId of new Set(
      [...sources.values()].map((source) => source.instanceId),
    )) {
      const { ttlMs } = await options.readPolicy(instanceId);
      const cutoff = now() - ttlMs;
      for (const source of [...sources.values()]) {
        if (source.instanceId !== instanceId || source.createdAt > cutoff) {
          continue;
        }
        sources.delete(source.id);
        removeDirectory(source.workDirectory);
      }
    }
  };

  const release = async (instanceId: string, id: string): Promise<boolean> => {
    const source = sources.get(id);
    if (!source || source.instanceId !== instanceId) return false;
    sources.delete(id);
    removeDirectory(source.workDirectory);
    return true;
  };

  const admit = async (
    source: SkillImportStagedSource,
  ): Promise<SkillImportStagedSource> => {
    sources.set(source.id, source);
    const { maxSources } = await options.readPolicy(source.instanceId);
    const own = [...sources.values()]
      .filter((entry) => entry.instanceId === source.instanceId)
      .sort((left, right) => left.createdAt - right.createdAt);
    while (own.length > maxSources) {
      const oldest = own.shift();
      if (oldest) await release(source.instanceId, oldest.id);
    }
    return source;
  };

  return {
    async stageGit(input) {
      await dropExpired();
      const workDirectory = join(
        parentDirectory,
        `kfw-skill-import-git-${randomUUID()}`,
      );
      const contentRoot = join(workDirectory, "content");
      mkdirSync(contentRoot, { recursive: true });
      try {
        const { fetchGitSkillSource } = await import("./import-source-git.js");
        const fetched = await withSourceDeadline(
          input.limits.timeoutMs,
          `克隆仓库超过 ${Math.round(input.limits.timeoutMs / 1000)} 秒，已中止。`,
          (signal) =>
            fetchGitSkillSource({
              url: input.url,
              destination: contentRoot,
              workDirectory,
              binary: input.binary,
              limits: input.limits,
              signal,
            }),
        );
        return await admit({
          id: randomUUID(),
          instanceId: input.instanceId,
          kind: "git",
          label: input.url,
          rootPath: contentRoot,
          workDirectory,
          sourceKey: fetched.sourceKey,
          createdAt: now(),
        });
      } catch (error) {
        removeDirectory(workDirectory);
        throw error;
      }
    },

    async stageZip(input) {
      await dropExpired();
      const workDirectory = join(
        parentDirectory,
        `kfw-skill-import-zip-${randomUUID()}`,
      );
      const contentRoot = join(workDirectory, "content");
      mkdirSync(contentRoot, { recursive: true });
      try {
        const { extractZipSource } = await import("./import-source-zip.js");
        const extracted = await withSourceDeadline(
          input.limits.timeoutMs,
          `解压压缩包超过 ${Math.round(input.limits.timeoutMs / 1000)} 秒，已中止。`,
          (signal) =>
            extractZipSource({
              stream: input.stream,
              destination: contentRoot,
              limits: input.limits,
              signal,
            }),
        );
        if (extracted.fileCount === 0) {
          throw new SkillImportSourceError("压缩包是空的。");
        }
        return await admit({
          id: randomUUID(),
          instanceId: input.instanceId,
          kind: "zip",
          label: input.fileName,
          rootPath: contentRoot,
          workDirectory,
          sourceKey: extracted.sourceKey,
          createdAt: now(),
        });
      } catch (error) {
        removeDirectory(workDirectory);
        throw error;
      }
    },

    async list(instanceId) {
      await dropExpired();
      return [...sources.values()]
        .filter((source) => source.instanceId === instanceId)
        .sort((left, right) => left.createdAt - right.createdAt);
    },

    async find(instanceId, id) {
      await dropExpired();
      const source = sources.get(id);
      return source?.instanceId === instanceId ? source : undefined;
    },

    release,

    async releaseAll(instanceId) {
      for (const source of [...sources.values()]) {
        if (source.instanceId === instanceId)
          await release(instanceId, source.id);
      }
    },

    dispose() {
      for (const source of [...sources.values()]) {
        sources.delete(source.id);
        removeDirectory(source.workDirectory);
      }
    },
  };
}

/** 上传文件名只留基本名与可打印字符，避免把路径或控制字符写进展示文案。 */
export function normalizeUploadFileName(raw: string | undefined): string {
  const base = (raw ?? "").split(/[\\/]/u).pop() ?? "";
  // 控制字符就是要剥掉的东西，这里必须显式匹配
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 剥掉上传文件名里的控制字符
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  if (!cleaned) {
    throw new SkillImportSourceError("上传的文件没有名字。");
  }
  return cleaned.slice(0, 200);
}
