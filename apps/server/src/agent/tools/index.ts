import type { StructuredTool } from "@langchain/core/tools";
import type { AnyBackendProtocol, BackendRuntime } from "deepagents";
import type { BlobStore } from "../../features/blob/types.js";
import type { CanvasRepository } from "../../features/canvas/repository.js";
import type {
  AvailableModel,
  AvailableVideoModel,
} from "../../generation/types.js";
import {
  createImageGenerateTool,
  type PersistImageFn,
  type SubmitImageJobFn,
} from "./image-generate.js";
import { createPersistSandboxFileTool } from "./persist-sandbox-file.js";
import { createProjectSearchTool } from "./project-search.js";
import {
  createVideoGenerateTool,
  type SubmitVideoJobFn,
} from "./video-generate.js";

// ---------------------------------------------------------------------------
// deepagents 内置工具参考 (由 FilesystemMiddleware 自动注入)
// ---------------------------------------------------------------------------
//
// deepagents@1.8.4 通过 createFilesystemMiddleware 自动注入以下工具，
// 我们自定义的工具名称不能与这些冲突：
//
//   ls          — 列出目录内容
//   read_file   — 读取文件内容（支持 offset/limit）
//   write_file  — 写入文件
//   edit_file   — 编辑文件（find & replace）
//   glob        — 按模式匹配文件路径
//   grep        — 按正则搜索文件内容
//   execute     — 执行 shell 命令（仅 SandboxBackendProtocol 时可用）
//   task        — 分发子任务到 subagent
//   write_todos — 管理 TODO 列表
//
// 我们使用 LocalShellBackend 作为 CompositeBackend 的 default backend，
// 它实现了 SandboxBackendProtocol，因此 execute 工具自动可用。
// 代码执行无需额外自定义工具。
//
// CompositeBackend 路由互不干扰：
//   /workspace/  → StoreBackend (PostgresStore) — 文件持久化
//   /memories/   → StoreBackend (PostgresStore) — agent 记忆
//   /skills/     → FilesystemBackend            — 系统 skills
//   default      → LocalShellBackend            — execute + 临时文件
// ---------------------------------------------------------------------------

/**
 * 工具装配的两条通路（DEC-2 收敛）：
 * - **服务型工具**（inspect/manipulate/screenshot_canvas、get_brand_kit）经内核
 *   注册表 `ctx.tools` 贡献，由 agent-runs 插件注册，按 preset 过滤 scope；
 * - **运行态工具**在此装配点创建——它们依赖 per-run 状态：`project_search`
 *   绑定 run 的 backend（grep 虚拟工作区）、`persist_sandbox_file` 的路径守卫
 *   必须与 backend 的沙箱目录口径一致、生图生频的 schema 内嵌工作区模型目录
 *   且提交闭包捕获 run 上下文。
 *
 * 生图生频归 design 专属（Code 会话无画布落点），运行态工具恒可用。
 */
export function createRunScopedTools(
  backend:
    | AnyBackendProtocol
    | ((runtime: BackendRuntime) => AnyBackendProtocol),
  deps: {
    /** 对象存储（blob 缝）：沙箱文件持久化等。 */
    blob: BlobStore;
    /** 画布数据访问（工作区作用域）：工作区解析经它。 */
    canvasRepository?: CanvasRepository;
    sandboxDir?: string;
    persistImage?: PersistImageFn;
    submitImageJob?: SubmitImageJobFn;
    submitVideoJob?: SubmitVideoJobFn;
    /** 工作区实例的模型清单（BYOK 目录 specifier，image/image-edit）。 */
    availableImageModels?: AvailableModel[];
    /** 工作区实例的视频模型清单（BYOK 目录 specifier）。 */
    availableVideoModels?: AvailableVideoModel[];
  },
  preset: "design" | "code",
): StructuredTool[] {
  const tools: StructuredTool[] = [
    createProjectSearchTool(backend),
    createPersistSandboxFileTool({
      blob: deps.blob,
      ...(deps.canvasRepository
        ? { canvasRepository: deps.canvasRepository }
        : {}),
      ...(deps.sandboxDir ? { sandboxDir: deps.sandboxDir } : {}),
    }),
  ];
  if (preset === "design") {
    tools.push(
      createImageGenerateTool({
        ...(deps.persistImage ? { persistImage: deps.persistImage } : {}),
        ...(deps.submitImageJob ? { submitImageJob: deps.submitImageJob } : {}),
        ...(deps.availableImageModels
          ? { availableModels: deps.availableImageModels }
          : {}),
      }),
      createVideoGenerateTool({
        ...(deps.submitVideoJob ? { submitVideoJob: deps.submitVideoJob } : {}),
        ...(deps.availableVideoModels
          ? { availableModels: deps.availableVideoModels }
          : {}),
      }),
    );
  }
  return tools;
}
