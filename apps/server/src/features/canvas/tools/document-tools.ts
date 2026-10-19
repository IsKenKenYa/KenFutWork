import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../../kernel/types.js";
import type { CanvasService } from "../canvas-service.js";
import type { CanvasDocumentAccess } from "../document-access.js";

function requestId(context: ToolExecutionContext): string {
  if (!context.toolCallId || !context.runId || !context.scopeHandle)
    throw new Error("画布创建缺少真实工具调用身份。 ");
  const bytes = createHash("sha256")
    .update(
      `${context.scopeHandle.describe().taskId}/${context.runId}/${context.toolCallId}`,
    )
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 文档CRUD共享工具权限、审批和可信Run身份，模型不能提交项目身份。 */
export function createCanvasDocumentToolDefinitions(deps: {
  canvas: CanvasService;
  access: CanvasDocumentAccess;
}): ToolDefinition[] {
  const name = z.string().trim().min(1).max(200);
  const revision = z.string().regex(/^[a-f0-9]{64}$/u);
  const define = <T extends z.ZodRawShape>(
    toolName: string,
    description: string,
    access: "read" | "write",
    shape: T,
    execute: (
      input: z.infer<z.ZodObject<T>>,
      context: ToolExecutionContext,
    ) => Promise<unknown>,
  ): ToolDefinition => {
    const schema = z.object(shape);
    return {
      name: toolName,
      description,
      scope: "design",
      access,
      parameters: z.toJSONSchema(schema),
      zodSchema: schema,
      execute: async (args, context) =>
        JSON.stringify(await execute(schema.parse(args), context)),
    };
  };
  return [
    define(
      "list_canvases",
      "List canvas documents in the current project, optionally searching their names.",
      "read",
      { query: z.string().max(200).optional() },
      async (input, context) => {
        const actor = await deps.access.authorize(context);
        return {
          canvases: await deps.canvas.listCanvases(
            actor,
            context.scopeHandle!.describe().projectId,
            input.query,
          ),
        };
      },
    ),
    define(
      "read_canvas",
      "Read a current-project canvas document, including its name, content and exact revision for conditional changes.",
      "read",
      {
        canvas_id: z.uuid({
          error: "画布引用无效，请从项目画布列表重新选择。",
        }),
      },
      async (input, context) => {
        const actor = await deps.access.authorize(context, input.canvas_id);
        return deps.canvas.getCanvas(actor, input.canvas_id);
      },
    ),
    define(
      "create_canvas",
      "Create a canvas document when the task requires one. Does not create a conversation or grant directory access.",
      "write",
      { name },
      async (input, context) => {
        const guard = () =>
          deps.access.authorize(context, undefined, "write").then(() => {});
        const actor = await deps.access.authorize(context, undefined, "write");
        return deps.canvas.createCanvas(
          actor,
          context.scopeHandle!.describe().projectId,
          { name: input.name, requestId: requestId(context) },
          guard,
        );
      },
    ),
    define(
      "rename_canvas",
      "Rename a canvas document after reading its current name and revision.",
      "write",
      {
        canvas_id: z.uuid({
          error: "画布引用无效，请从项目画布列表重新选择。",
        }),
        name,
        expected_name: name,
        expected_revision: revision,
      },
      async (input, context) => {
        const guard = () =>
          deps.access
            .authorize(context, input.canvas_id, "write")
            .then(() => {});
        const actor = await deps.access.authorize(
          context,
          input.canvas_id,
          "write",
        );
        return deps.canvas.renameCanvas(
          actor,
          input.canvas_id,
          {
            name: input.name,
            expectedName: input.expected_name,
            expectedRevision: input.expected_revision,
          },
          guard,
        );
      },
    ),
    define(
      "delete_canvas",
      "Delete a current-project canvas document index after reading its revision. Keeps source files, assets and conversation history.",
      "write",
      {
        canvas_id: z.uuid({
          error: "画布引用无效，请从项目画布列表重新选择。",
        }),
        expected_revision: revision,
      },
      async (input, context) => {
        const guard = () =>
          deps.access
            .authorize(context, input.canvas_id, "write")
            .then(() => {});
        const actor = await deps.access.authorize(
          context,
          input.canvas_id,
          "write",
        );
        await deps.canvas.deleteCanvas(
          actor,
          input.canvas_id,
          input.expected_revision,
          guard,
        );
        return { ok: true, canvasId: input.canvas_id };
      },
    ),
  ];
}
