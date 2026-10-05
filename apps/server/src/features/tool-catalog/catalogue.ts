import { ToolMessage } from "@langchain/core/messages";
import { type AgentMiddleware, tool } from "langchain";
import { z } from "zod";
import { kernelToolToStructuredTool } from "../../agent/kernel-tools-bridge.js";
import type { AgentRunExtensionContext } from "../../agent/run-extension.js";
import type { ToolDefinition } from "../../kernel/types.js";
import type { CodeApprovalMode } from "../permissions/approval-types.js";
import { codePermissionPolicy } from "../permissions/code-policy.js";

export interface ToolActivation {
  generation: number;
  names: Set<string>;
}
const searchSchema = z
  .object({
    query: z.string().trim().min(1),
    max_results: z.number().int().positive().optional(),
  })
  .strict();

function readOnly(context: AgentRunExtensionContext): boolean {
  const handle = context.execution.scopeHandle;
  return Boolean(
    handle &&
      (handle.role === "explore" ||
        handle.role === "review" ||
        handle.describe().sandboxMode === "read-only"),
  );
}
function score(definition: ToolDefinition, query: string): number {
  const name = definition.name.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/u);
  // 固定排序权重是检索算法，不是执行次数、超时或容量限额。
  return terms.reduce(
    (total, term) =>
      total +
      (name === term
        ? 10
        : name.includes(term)
          ? 5
          : definition.description.toLowerCase().includes(term)
            ? 1
            : 0),
    0,
  );
}

/** 常规工具发现；不请求第二个模型、不要求供应商原生 tool-search。 */
export function createToolCatalogueMiddleware(
  context: AgentRunExtensionContext,
  activation: ToolActivation,
  resolveLimit: () => Promise<number>,
): AgentMiddleware {
  let approvalMode: CodeApprovalMode | undefined;
  const refresh = async () => {
    context.execution.signal?.throwIfAborted();
    await context.execution.scopeHandle?.resolvePath(".", "read");
    const policy = await context.execution.codeApproval?.resolve();
    approvalMode = policy?.mode;
    return policy;
  };
  const available = (): ToolDefinition[] => {
    const generation =
      context.execution.scopeHandle?.describe().generation ?? 0;
    if (generation !== activation.generation) {
      activation.names.clear();
      activation.generation = generation;
    }
    const definitions = context.registry
      .resolveRunTools(context.resolution)
      .filter(
        (definition) =>
          !readOnly(context) ||
          definition.access === "read" ||
          (definition.access === "execute" &&
            definition.readonlyExecution === true),
      );
    const permitted = definitions.filter((definition) => {
      const scope = context.execution.scopeHandle;
      const ceiling = context.execution.codeApproval?.ceiling;
      if (!scope || !approvalMode || !ceiling) return true;
      return (
        codePermissionPolicy({
          role: scope.role,
          mode: approvalMode,
          approvalCeiling: ceiling,
          toolName: definition.name,
          access: definition.access,
          readonlyExecution: definition.readonlyExecution,
        }) !== "deny"
      );
    });
    const names = new Set(permitted.map((definition) => definition.name));
    for (const name of activation.names)
      if (!names.has(name)) activation.names.delete(name);
    return permitted;
  };
  const discover = tool(
    async (raw) => {
      const input = searchSchema.parse(raw);
      await refresh();
      const limit = await resolveLimit();
      const candidates = available()
        .map((definition) => ({
          definition,
          score: score(definition, input.query),
        }))
        .filter((entry) => entry.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.definition.name.localeCompare(right.definition.name),
        );
      const selected = candidates.slice(
        0,
        Math.min(input.max_results ?? limit, limit),
      );
      for (const { definition } of selected)
        if (definition.exposure === "deferred")
          activation.names.add(definition.name);
      return {
        tools: selected.map(({ definition }) => ({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          access: definition.access ?? "unknown",
          activated: true,
        })),
        totalMatches: candidates.length,
        truncated: selected.length < candidates.length,
        authorization:
          "发现只激活工具 schema；执行仍核对当前模式、角色、目录、审批与真实能力。",
      };
    },
    {
      name: "ToolSearch",
      description:
        "按名称或用途查找当前允许发现的插件/MCP工具，并激活到下一模型请求。核心工具始终可用；工具发现不授予执行权限。",
      schema: searchSchema,
    },
  );

  return {
    name: "ToolCatalogue",
    tools: [discover],
    async wrapModelCall(request, handler) {
      const policy = await refresh();
      const systemPrompt = context.prompt
        ? await context.prompt.registry.compose({
            ...context.prompt.composition,
            executionScope: context.execution.scopeHandle?.describe(),
            executionRole: context.execution.scopeHandle?.role,
            approvalMode: policy?.mode,
            approvalCeiling: context.execution.codeApproval?.ceiling,
            planEnabled: policy?.planEnabled,
          })
        : request.systemPrompt;
      const definitions = available().filter(
        (definition) =>
          definition.exposure !== "deferred" ||
          activation.names.has(definition.name),
      );
      const bound = definitions.map(
        (definition) =>
          request.tools.find(
            (candidate) => candidate.name === definition.name,
          ) ??
          kernelToolToStructuredTool(
            {
              ...definition,
              execute: (args, execCtx) =>
                context.registry.executeDefinition(definition, args, execCtx),
            },
            context.execution,
          ),
      );
      // SDK todo 工具仍由共同 scaffold 提供；其它工具全部从当前注册事实组装。
      const scaffold = request.tools.filter(
        (candidate) => candidate.name === "write_todos",
      );
      return handler({
        ...request,
        systemPrompt,
        tools: [...bound, discover, ...scaffold],
      });
    },
    async wrapToolCall(request, handler) {
      await refresh();
      if (request.toolCall.name === "ToolSearch")
        return handler({ ...request, tool: discover });
      const definition = available().find(
        (candidate) => candidate.name === request.toolCall.name,
      );
      if (!definition) {
        if (request.toolCall.name === "write_todos") return handler(request);
        return new ToolMessage({
          tool_call_id: request.toolCall.id ?? "",
          status: "error",
          content: `工具未注册、已卸载或当前${approvalMode ?? ""}模式/角色/目录权限拒绝访问，请重新 ToolSearch。`,
        });
      }
      if (
        definition.exposure === "deferred" &&
        !activation.names.has(definition.name)
      )
        return new ToolMessage({
          tool_call_id: request.toolCall.id ?? "",
          status: "error",
          content:
            "可选工具尚未激活，请先用 ToolSearch 发现；发现不会自动批准执行。",
        });
      return handler({
        ...request,
        tool: kernelToolToStructuredTool(
          {
            ...definition,
            execute: (args, execCtx) =>
              context.registry.executeDefinition(definition, args, execCtx),
          },
          context.execution,
        ),
      });
    },
  };
}
