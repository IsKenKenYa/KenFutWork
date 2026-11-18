import type {
  RunToolResolutionContext,
  ToolExecutionContext,
  ToolRegistry,
} from "../kernel/types.js";
import type { AgentProviderTools } from "./provider-contract.js";

/** This port delegates the existing Kernel executor, including schema, fresh scope and actual admit/claim. */
export function createAgentProviderTools(
  registry: ToolRegistry,
  resolution: RunToolResolutionContext,
  execution: ToolExecutionContext,
): AgentProviderTools {
  let executing = 0;
  return {
    get catalog() {
      return registry.resolveRunTools(resolution).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: structuredClone(tool.parameters),
      }));
    },
    isExecuting: () => executing > 0,
    async execute(name, args, toolCallId) {
      if (!toolCallId.trim()) throw new Error("工具调用缺少实际身份。");
      const definition = registry
        .resolveRunTools(resolution)
        .find((tool) => tool.name === name);
      if (!definition) throw new Error("工具不属于当前Task能力目录。");
      executing++;
      try {
        return await registry.executeDefinition(definition, args, {
          ...execution,
          toolCallId,
        });
      } finally {
        executing--;
      }
    },
  };
}
