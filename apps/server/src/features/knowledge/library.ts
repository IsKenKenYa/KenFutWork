/**
 * 知识库托管目录（「云盘式」上传）。
 *
 * 用户只把文件丢进来，其余自动：文件落到 `<dataDir>/knowledge/library/` 下，
 * 该目录本身作为**一个**知识库根注册给 SAG，索引由上游 watcher 增量维护。
 *
 * 为什么不是每个文件一个根：上游 `sag add` 以目录为单位，逐文件注册会产出
 * 大量根、状态列表爆炸；托管目录是单根 + 子路径，语义更接近网盘。
 *
 * 安全：文件名只保留基名、拒绝 `..`/绝对路径/控制字符，重名自动加序号，
 * 不覆盖既有文件；单文件预算沿用 `knowledgeReadMaxBytes` 同档治理值。
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface KnowledgeLibraryFile {
  /** 相对托管目录的路径（展示用）。 */
  path: string;
  /** 绝对路径（可直接交给 knowledge_read）。 */
  absolutePath: string;
  sizeBytes: number;
}

export interface KnowledgeLibraryDeps {
  dataDir: string;
  /** 单文件字节上限（治理值）。 */
  maxBytes: number;
}

function sanitizeName(raw: string): string {
  // 只取基名并剔除路径分隔与控制字符；Windows 非法字符一并替换。
  const base = basename(raw.replace(/\\/gu, "/"));
  // `\p{Cc}` 覆盖全部控制字符（等价于 0x00-0x1F），并避开字面控制字符的 lint 规则。
  const cleaned = base
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, "_")
    .replace(/^\.+/u, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "file";
}

export function createKnowledgeLibrary(deps: KnowledgeLibraryDeps) {
  const root = join(deps.dataDir, "knowledge", "library");

  async function ensureDir(): Promise<string> {
    await mkdir(root, { recursive: true });
    return root;
  }

  return {
    /** 托管目录的绝对路径（作为知识库根注册）。 */
    async path(): Promise<string> {
      return ensureDir();
    },

    /** 写入一个文件；重名自动加序号，不覆盖。 */
    async save(
      originalName: string,
      bytes: Buffer,
    ): Promise<KnowledgeLibraryFile> {
      if (bytes.byteLength === 0) throw new Error("文件内容为空。");
      if (bytes.byteLength > deps.maxBytes) {
        throw new Error(
          `文件超过 ${Math.floor(deps.maxBytes / 1024 / 1024)}MB 上限。`,
        );
      }
      const dir = await ensureDir();
      const name = sanitizeName(originalName);
      // `sanitizeName` 已剥掉路径分隔符与 `..`，Join 后必然落在托管目录内。
      let finalName = name;
      for (let index = 2; index <= 999; index += 1) {
        try {
          await stat(join(dir, finalName));
          const ext = name.lastIndexOf(".");
          finalName =
            ext > 0
              ? `${name.slice(0, ext)} (${index})${name.slice(ext)}`
              : `${name} (${index})`;
        } catch {
          break;
        }
      }
      const finalPath = join(dir, finalName);
      await writeFile(finalPath, bytes);
      return {
        path: finalName,
        absolutePath: finalPath,
        sizeBytes: bytes.byteLength,
      };
    },

    /** 列出托管目录下的文件（只列一层，够网盘视图用）。 */
    async list(): Promise<KnowledgeLibraryFile[]> {
      let entries: Array<{ name: string; isFile(): boolean }>;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        return [];
      }
      const files: KnowledgeLibraryFile[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith(".")) continue;
        const absolutePath = join(root, entry.name);
        try {
          const info = await stat(absolutePath);
          files.push({
            path: entry.name,
            absolutePath,
            sizeBytes: info.size,
          });
        } catch {
          // 并发删除等：跳过即可
        }
      }
      return files.sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}

export type KnowledgeLibrary = ReturnType<typeof createKnowledgeLibrary>;
