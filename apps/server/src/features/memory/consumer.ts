import type {
  PromptCompositionContext,
  PromptSectionDefinition,
  ToolDefinition,
} from "../../kernel/types.js";
import type { ProjectMemoryService } from "./project-memory.js";

const MEMORY_SECTION_ORDER = 290;

/**
 * 项目长期记忆提示段（code 作用域）。
 *
 * 开启记忆的 Task 每轮拿到 `MEMORY.md` 索引与记忆目录；未开启时整段不出现，
 * 模型也就没有「可以先查记忆」的先验。索引读取失败按 fast-fail 透传——
 * 静默吞掉会让模型以为记忆为空、重复写同一条。
 */
export function createProjectMemoryPromptSection(
  memory: ProjectMemoryService,
): PromptSectionDefinition {
  return {
    name: "workspace.project-memory",
    order: MEMORY_SECTION_ORDER,
    scope: "code",
    resolve: async (ctx: PromptCompositionContext) => {
      const location = locateMemory(ctx);
      if (!location) return null;
      if (!(await memory.isEnabled(location.instanceId))) return null;
      const index = await memory.readIndex(
        location.instanceId,
        location.projectId,
      );
      const directory = memory.memoryDirectory(location.projectId);
      const body = index?.trim() ? index.trim() : "（还没有记忆，索引为空）";
      return [
        "## 项目长期记忆",
        "",
        `记忆目录：${directory}`,
        "索引（MEMORY.md）：",
        body,
        "",
        "保存一条记忆用 `memory_save`（标题 + 正文）；它会把正文写成独立文件并在 MEMORY.md 追加一行。只在结论值得跨会话保留时写。",
      ].join("\n");
    },
  };
}

/** 写入工具：独立文件 + 索引行；关闭记忆或非 Code Task 时如实拒绝。 */
export function createMemorySaveTool(
  memory: ProjectMemoryService,
): ToolDefinition {
  return {
    name: "memory_save",
    description:
      "把一条值得跨会话保留的结论写入项目长期记忆。参数是标题与正文；正文写进独立文件，并在 MEMORY.md 追加一行索引。只有开启记忆的项目可用。",
    scope: "code",
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
      const scope = execCtx.scopeHandle?.describe();
      if (!scope || !execCtx.actor)
        throw new Error("memory_save 只能在 Code Task 的运行中使用。");
      const title = String(args.title ?? "").trim();
      const content = String(args.content ?? "").trim();
      if (!title) throw new Error("memory_save 需要 title 参数。");
      if (!content) throw new Error("memory_save 需要 content 参数。");
      const saved = await memory.saveMemory(execCtx.actor, {
        projectId: scope.projectId,
        title,
        content,
      });
      return { saved: true, ...saved };
    },
  };
}

function locateMemory(
  ctx: PromptCompositionContext,
): { instanceId: string; projectId: string } | null {
  const scope = ctx.scopeHandle?.describe();
  const instanceId = scope?.instanceId ?? ctx.instanceId;
  const projectId = scope?.projectId;
  if (!instanceId || !projectId) return null;
  return { instanceId, projectId };
}
