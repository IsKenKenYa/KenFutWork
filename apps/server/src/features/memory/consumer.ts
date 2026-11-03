import type {
  PromptCompositionContext,
  PromptSectionDefinition,
  ToolDefinition,
} from "../../kernel/types.js";
import type { ProjectMemoryService } from "./project-memory.js";

const MEMORY_SECTION_ORDER = 290;

/**
 * 项目长期记忆提示段（所有预设）。
 *
 * 开启记忆的 Task 每轮拿到 `MEMORY.md` 索引与记忆目录；未开启时整段不出现，
 * 模型也就没有「可以先查记忆」的先验。Design 运行没有 Task 句柄时，用画布
 * 映射到所属项目，并把旧 `/memories/` 通道的数据迁进同一项目目录。
 * 索引读取失败按 fast-fail 透传——静默吞掉会让模型以为记忆为空、重复写同一条。
 */
export function createProjectMemoryPromptSection(
  memory: ProjectMemoryService,
): PromptSectionDefinition {
  return {
    name: "workspace.project-memory",
    order: MEMORY_SECTION_ORDER,
    scope: "always",
    resolve: async (ctx: PromptCompositionContext) => {
      const scope = ctx.scopeHandle?.describe();
      const actor = ctx.execution?.actor;
      if (!actor) return null;
      const canvasId =
        ctx.execution?.canvasId ?? ctx.execution?.workContext?.canvasId;
      const projectId = await memory.resolveProjectId(actor, {
        projectId: scope?.projectId,
        canvasId,
      });
      if (!projectId) return null;
      const instanceId = scope?.instanceId ?? ctx.instanceId;
      if (!instanceId) return null;
      if (!(await memory.isEnabled(instanceId))) return null;
      // 旧 Design 记忆是画布级数据；每轮 Design 运行补迁一次，晚到的旧写入
      // 也会在下一轮进来，不再被新通道静默甩开。
      if (ctx.preset === "design" && canvasId)
        await memory.migrateLegacyCanvasMemory(actor, { projectId, canvasId });
      const index = await memory.readIndex(instanceId, projectId);
      const directory = memory.memoryDirectory(projectId);
      const body = index?.trim()
        ? index.trim()
        : "（还没有记忆，索引为空）";
      return [
        "## 项目长期记忆",
        "",
        `记忆目录：${directory}`,
        "索引（MEMORY.md）：",
        body,
        "",
        "保存一条记忆用 `memory_save`（标题 + 正文）；它会把正文写成独立文件并在 MEMORY.md 追加一行。只在结论值得跨会话保留时写。",
        "用户明确要求记住某个结论时，在结束回答前调用一次 `memory_save`；需要旧结论而索引里没有时，用 `memory_search` 按关键词查正文。",
      ].join("\n");
    },
  };
}

/** 召回工具：按关键词搜项目记忆正文与索引，结果受单次读取上限约束。 */
export function createMemorySearchTool(
  memory: ProjectMemoryService,
): ToolDefinition {
  return {
    name: "memory_search",
    description:
      "在项目长期记忆里按关键词查找正文与索引。多个关键词用空格分隔，全部命中才算匹配；返回文件名、标题与命中行。需要旧结论而 MEMORY.md 索引里没有时使用。",
    scope: "shared",
    exposure: "deferred",
    access: "read",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词，多个用空格分隔",
        },
      },
      required: ["query"],
    },
    execute: async (args, execCtx) => {
      if (!execCtx.actor)
        throw new Error("memory_search 只能在运行中使用。");
      const scope = execCtx.scopeHandle?.describe();
      const canvasId = execCtx.canvasId ?? execCtx.workContext?.canvasId;
      const projectId = await memory.resolveProjectId(execCtx.actor, {
        projectId: scope?.projectId,
        canvasId,
      });
      if (!projectId)
        throw new Error(
          "memory_search 只能在 Code Task 或 Design 画布的运行中使用。",
        );
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("memory_search 需要 query 参数。");
      return memory.searchMemories(execCtx.actor, { projectId, query });
    },
  };
}

/** 写入工具：独立文件 + 索引行；Code 取 Task 项目，Design 取画布所属项目。 */
export function createMemorySaveTool(
  memory: ProjectMemoryService,
): ToolDefinition {
  return {
    name: "memory_save",
    description:
      "把一条值得跨会话保留的结论写入项目长期记忆。参数是标题与正文；正文写进独立文件，并在 MEMORY.md 追加一行索引。只有开启记忆的项目可用。",
    scope: "shared",
    exposure: "deferred",
    access: "write",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "记忆标题（一句话）" },
        content: {
          type: "string",
          description: "记忆正文（Markdown，写清结论与原因）",
        },
      },
      required: ["title", "content"],
    },
    execute: async (args, execCtx) => {
      if (!execCtx.actor)
        throw new Error("memory_save 只能在运行中使用。");
      const scope = execCtx.scopeHandle?.describe();
      const canvasId = execCtx.canvasId ?? execCtx.workContext?.canvasId;
      const projectId = await memory.resolveProjectId(execCtx.actor, {
        projectId: scope?.projectId,
        canvasId,
      });
      if (!projectId)
        throw new Error(
          "memory_save 只能在 Code Task 或 Design 画布的运行中使用。",
        );
      const title = String(args.title ?? "").trim();
      const content = String(args.content ?? "").trim();
      if (!title) throw new Error("memory_save 需要 title 参数。");
      if (!content) throw new Error("memory_save 需要 content 参数。");
      const saved = await memory.saveMemory(execCtx.actor, {
        projectId,
        title,
        content,
      });
      return { saved: true, ...saved };
    },
  };
}
