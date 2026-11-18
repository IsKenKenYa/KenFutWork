/**
 * shared 工具（M3，规划 §2.4 第 3 层）：knowledge_search / knowledge_read /
 * knowledge_status。`registerDynamic` per-run 解析：bundle 未装载（未安装/停用）
 * 返回 null，工具不可见；装/卸下一轮即生效。
 *
 * 同步门控用 `listUiEntries()`：bundle 装载时注册侧栏面板，卸载/停用即收回——
 * 这是注册表唯一的同步安装态视图（`list()` 是异步的，resolve 不能用）。
 */

import { knowledgeSearchRequestSchema } from "@kenfutwork/shared";
import { z } from "zod";
import type {
  DynamicToolEntry,
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import type { PluginsServiceLike } from "./service.js";
import type { KnowledgeSettingsReader } from "./settings.js";
import { KNOWLEDGE_BUNDLE_ID, type KnowledgeService } from "./types.js";

/** 与 `plugins/knowledge` 清单及 index.js 注册的面板 id 对齐。 */
export const KNOWLEDGE_PANEL_ID = "knowledge-sidebar";

export function knowledgeBundleLoaded(
  plugins: PluginsServiceLike | undefined,
): boolean {
  const entries = plugins?.listUiEntries?.() ?? [];
  return entries.some(
    (entry) =>
      entry.id === KNOWLEDGE_PANEL_ID &&
      (entry.pluginId === KNOWLEDGE_BUNDLE_ID ||
        entry.pluginId.endsWith(`__${KNOWLEDGE_BUNDLE_ID}`)),
  );
}

function instanceOf(ctx: ToolExecutionContext): string | undefined {
  return (
    ctx.instanceId ??
    ctx.scopeHandle?.describe().instanceId ??
    ctx.actor?.instanceId
  );
}

const readSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  })
  .strict();

const statusSchema = z.object({}).strict();

export function createKnowledgeToolEntries(deps: {
  knowledge: KnowledgeService;
  readSettings: KnowledgeSettingsReader;
  tryGetPlugins: () => PluginsServiceLike | undefined;
}): DynamicToolEntry[] {
  const resolve = (make: () => ToolDefinition): DynamicToolEntry["resolve"] => {
    return () => (knowledgeBundleLoaded(deps.tryGetPlugins()) ? make() : null);
  };

  const searchTool = (): ToolDefinition => ({
    name: "knowledge_search",
    scope: "shared",
    exposure: "core",
    access: "read",
    description:
      "检索本地知识库（SAG2）。返回证据的路径、行号与正文片段；多跳线索可换关键词再查。只读，不修改任何文件。",
    parameters: z.toJSONSchema(knowledgeSearchRequestSchema),
    zodSchema: knowledgeSearchRequestSchema,
    async execute(args, execCtx) {
      const input = knowledgeSearchRequestSchema.parse(args);
      const settings = await deps.readSettings(instanceOf(execCtx));
      return deps.knowledge.search({
        query: input.query,
        ...(input.path ? { path: input.path } : {}),
        maxResults: input.maxResults ?? settings.maxResults,
        timeoutMs: settings.searchTimeoutMs,
        localMatch: settings.localMatch,
        ...(execCtx.signal ? { signal: execCtx.signal } : {}),
      });
    },
  });

  const readTool = (): ToolDefinition => ({
    name: "knowledge_read",
    scope: "shared",
    exposure: "core",
    access: "read",
    description:
      "按证据位置取知识库原文片段（路径用证据里的 absolutePath，行号 1 起）。只能读已注册知识库根内的文件。",
    parameters: z.toJSONSchema(readSchema),
    zodSchema: readSchema,
    async execute(args, execCtx) {
      const input = readSchema.parse(args);
      const settings = await deps.readSettings(instanceOf(execCtx));
      return deps.knowledge.read({
        path: input.path,
        ...(input.startLine === undefined
          ? {}
          : { startLine: input.startLine }),
        ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
        maxBytes: settings.readMaxBytes,
      });
    },
  });

  const statusTool = (): ToolDefinition => ({
    name: "knowledge_status",
    scope: "shared",
    exposure: "core",
    access: "read",
    description:
      "查看本地知识库就绪状态（安装态/CLI/平台/未就绪原因）与当前检索设置。",
    parameters: z.toJSONSchema(statusSchema),
    zodSchema: statusSchema,
    async execute(_args, execCtx) {
      return {
        ...(await deps.knowledge.status()),
        settings: await deps.readSettings(instanceOf(execCtx)),
      };
    },
  });

  return [
    { id: "knowledge.search", scope: "shared", resolve: resolve(searchTool) },
    { id: "knowledge.read", scope: "shared", resolve: resolve(readTool) },
    { id: "knowledge.status", scope: "shared", resolve: resolve(statusTool) },
  ];
}
