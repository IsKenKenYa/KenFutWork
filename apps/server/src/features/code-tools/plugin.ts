import { readFile, stat } from "node:fs/promises";

import type { BackendProtocolV2 } from "deepagents";

import type { PluginDefinition, ToolDefinition } from "../../kernel/types.js";
import { diffLines, summarizeDiff } from "./diff.js";
import { createPersistSandboxFileToolDefinition } from "./persist-sandbox-file.js";
import { createProjectSearchToolDefinition } from "./project-search.js";
import { codeModePromptSection } from "./prompt.js";

/**
 * code 能力层工具（P6）：文件预览 + 差异分析，向 ctx.tools 注册（scope: code）。
 * 文件预览复用 deepagents fs 工具之外的场景化预览（元数据 + 截断内容）。
 * code 模式提示段（挂载即出现）同属本插件。project_search / persist_sandbox_file
 * 是 per-run 动态工具（backend/沙箱目录绑定）——经内核动态工具缝解析，scope=shared。
 */

const PREVIEW_MAX_BYTES = 64 * 1024;

export const previewFileTool: ToolDefinition = {
  name: "preview_file",
  description:
    "预览文件：返回大小/类型元数据与截断后的文本内容（代码/文本类），不修改文件。",
  scope: "code",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件绝对路径" },
    },
    required: ["path"],
  },
  execute: async (args) => {
    const path = String(args.path ?? "");
    if (!path) {
      throw new Error("preview_file 需要 path 参数");
    }
    const info = await stat(path);
    if (!info.isFile()) {
      throw new Error(`不是常规文件：${path}`);
    }
    const buffer = await readFile(path);
    const truncated = buffer.length > PREVIEW_MAX_BYTES;
    return {
      path,
      sizeBytes: info.size,
      truncated,
      content: buffer.subarray(0, PREVIEW_MAX_BYTES).toString("utf8"),
    };
  },
};

export const diffFilesTool: ToolDefinition = {
  name: "diff_files",
  description: "对比两个文件的行级差异，返回 +N -M 统计与差异片段。",
  scope: "code",
  parameters: {
    type: "object",
    properties: {
      beforePath: { type: "string", description: "基线文件路径" },
      afterPath: { type: "string", description: "目标文件路径" },
    },
    required: ["beforePath", "afterPath"],
  },
  execute: async (args) => {
    const beforePath = String(args.beforePath ?? "");
    const afterPath = String(args.afterPath ?? "");
    if (!beforePath || !afterPath) {
      throw new Error("diff_files 需要 beforePath 与 afterPath 参数");
    }
    const [before, after] = await Promise.all([
      readFile(beforePath, "utf8"),
      readFile(afterPath, "utf8"),
    ]);
    const lines = diffLines(before, after);
    return {
      beforePath,
      afterPath,
      summary: summarizeDiff(lines),
      lines,
    };
  },
};

export function createCodeToolsPlugin(): PluginDefinition {
  return {
    name: "code-tools",
    inject: ["blob"],
    apply(ctx) {
      const tools = ctx.get("tools");
      tools.register(previewFileTool);
      tools.register(diffFilesTool);
      // code 模式段：提示与工具同属主（挂载即出现）
      ctx.get("systemPrompt").register(codeModePromptSection);

      // project_search：backend 绑定 per-run（grep 虚拟工作区）——动态解析。
      // 实例化口径与 deep-agent 的 execute_background 探测一致（store + 空 state）。
      tools.registerDynamic({
        id: "workspace.project-search",
        scope: "shared",
        resolve: (run) =>
          createProjectSearchToolDefinition({
            // 工厂产物为 AnyBackendProtocol 联合；grep 工具按 V2 协议消费
            // （与 deep-agent 的 execute_background 能力探测同款实例化口径）
            backend: run.backendFactory({
              ...(run.store ? { store: run.store } : {}),
              state: {},
            } as never) as BackendProtocolV2,
          }),
      });
      // persist_sandbox_file：沙箱目录守卫与 backend 口径一致（per-run 事实）
      tools.registerDynamic({
        id: "workspace.persist-sandbox-file",
        scope: "shared",
        resolve: (run) =>
          createPersistSandboxFileToolDefinition({
            blob: ctx.get("blob"),
            ...(run.sandboxDir ? { sandboxDir: run.sandboxDir } : {}),
          }),
      });
    },
  };
}
