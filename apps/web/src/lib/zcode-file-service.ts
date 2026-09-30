/**
 * zcode fileService 宿主实现（P5b，手册 §7「mention 数据源接服务端文件搜索」）：
 * `searchWorkspaceFiles` 走我方服务端能力——
 * - query 非空：`/api/code/index/search`（代码索引全文/路径搜索，去重取文件路径）
 * - query 为空：`/api/code/files` 根目录一层列举
 * 映射为 zcode `WorkspaceFileEntry`（name/path/relativePath/type）供 mention 面板展示。
 * 其余方法（stat/readMediaPreview）保持未接通（消费方均有 optional 兜底）。
 * 适配注记：这是 ZCodeFileServiceSlice 的宿主数据源实现，非照搬件。
 */
"use client";

import type { ZCodeFileServiceSlice } from "@zui/hooks/useServices";
import type { WorkspaceFileEntry } from "@zui/lib/zcode-shared";
import { fetchCodeFiles } from "@/lib/code-git-api";
import { searchCodeIndex } from "@/lib/server-api";

export function createHostFileService(deps: {
  accessToken: string | null;
  /** 工作目录绑定的项目主画布（run 作用域同款，Code 模式「工作目录=项目」）。 */
  canvasId: string | null;
}): ZCodeFileServiceSlice {
  const { accessToken, canvasId } = deps;

  const requireScope = () => {
    if (!accessToken || !canvasId) {
      throw new Error("fileService 未就绪：缺少会话令牌或工作目录绑定");
    }
    return { accessToken, canvasId };
  };

  return {
    async stat() {
      // 照搬消费方（message.tsx 的「在编辑器打开」链）在我们宿主里被 stub 降级；
      // 此实现仅服务 mention 面板，stat 保持未接通口径。
      throw new Error("fileService.stat 未接通（宿主无编辑器缝）");
    },
    async readMediaPreview() {
      throw new Error("fileService.readMediaPreview 未接通");
    },
    async searchWorkspaceFiles({ query, limit }) {
      const scope = requireScope();
      const cap = limit ?? 20;
      const trimmed = query.trim();

      if (trimmed.length === 0) {
        // 空查询 = 根目录一层列举（zcode 空查询口径）
        const listing = await fetchCodeFiles(
          scope.accessToken,
          scope.canvasId,
          "",
        );
        return listing.entries.slice(0, cap).map((entry) => ({
          name: entry.name,
          path: entry.path,
          relativePath: entry.path,
          type:
            entry.type === "dir" ? ("directory" as const) : ("file" as const),
        }));
      }

      // 非空查询优先走代码索引（name/path/content 三路命中，去重取路径）；
      // 索引库未开启（服务端业务错误）时回退目录列举按名过滤——面板内自然
      // 显示「无结果」而不是把服务端错误甩成红横幅（P5b 真机）。
      try {
        const { hits } = await searchCodeIndex(
          scope.accessToken,
          scope.canvasId,
          trimmed,
        );
        const seen = new Set<string>();
        const entries: WorkspaceFileEntry[] = [];
        for (const hit of hits) {
          if (seen.has(hit.path)) continue;
          seen.add(hit.path);
          const segments = hit.path.split("/");
          entries.push({
            name: segments.at(-1) ?? hit.path,
            path: hit.path,
            relativePath: hit.path,
            type: "file",
          });
          if (entries.length >= cap) break;
        }
        return entries;
      } catch {
        const listing = await fetchCodeFiles(
          scope.accessToken,
          scope.canvasId,
          "",
        );
        const needle = trimmed.toLowerCase();
        return listing.entries
          .filter((entry) => entry.name.toLowerCase().includes(needle))
          .slice(0, cap)
          .map((entry) => ({
            name: entry.name,
            path: entry.path,
            relativePath: entry.path,
            type:
              entry.type === "dir" ? ("directory" as const) : ("file" as const),
          }));
      }
    },
  };
}
