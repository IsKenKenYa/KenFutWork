import { ToolMessage } from "@langchain/core/messages";
import { createFilesystemMiddleware } from "deepagents";
import type { AgentMiddleware } from "langchain";

/** Code结果已由Task工具限制/归档；SDK的文字驱逐会把base64图片变成不可读的.txt。 */
export function createCodeFilesystemMiddleware(
  backend: NonNullable<
    NonNullable<Parameters<typeof createFilesystemMiddleware>[0]>["backend"]
  >,
): AgentMiddleware {
  return createFilesystemMiddleware({
    backend,
    tools: ["read_file"],
    toolTokenLimitBeforeEvict: null,
  }) as unknown as AgentMiddleware;
}

/** SDK scaffold 保留；Code 仅通过本 profile 的版本/权限/进程工具执行用户动作。 */
export function createNativeToolExclusionMiddleware(): AgentMiddleware {
  const excluded = new Set([
    "ls",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "grep",
    "execute",
    "task",
  ]);
  return {
    name: "CodeCoreToolOwnership",
    wrapModelCall(request, handler) {
      return handler({
        ...request,
        tools: request.tools.filter(
          (tool) => typeof tool.name !== "string" || !excluded.has(tool.name),
        ),
      });
    },
    wrapToolCall(request, handler) {
      if (!excluded.has(request.toolCall.name)) return handler(request);
      return new ToolMessage({
        tool_call_id: request.toolCall.id ?? "",
        content:
          "该 SDK 内置工具没有绑定当前 Task 的工作域、观察版本或执行生命周期。请使用本轮提供的 Read/Glob/Grep/Write/Edit/ApplyPatch/Bash 与子代理工具。",
      });
    },
  };
}
