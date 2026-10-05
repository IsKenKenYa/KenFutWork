import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import { z } from "zod";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { AxNode } from "./ax-tree.js";
import { readPngWithinBudget } from "./budget.js";
import type {
  ComputerUseExecutor,
  CuInputAction,
  CuOperationContext,
  CuRaster,
  CuTreeLimits,
} from "./executor.js";
import { CU_AX_DEFAULT_LIMITS } from "./executor.js";
import type { CuToolResult } from "./service.js";
import type { CuTarget, ParsedAppRef } from "./target.js";

const idSchema = z.number().int().nonnegative();
const boundsSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite().nonnegative(),
  z.number().finite().nonnegative(),
]);
const permissionSchema = z.enum(["granted", "denied", "not_determined"]);
const accessSchema = z.object({
  permissionStatus: z.object({
    accessibility: permissionSchema,
    screen: permissionSchema,
    postEvents: permissionSchema.optional(),
  }),
  hint: z.string(),
});
const appSchema = z.object({
  pid: idSchema.positive().nullable(),
  name: z.string().nullable(),
  bundleId: z.string().nullable(),
  active: z.boolean(),
});
const windowSchema = z.object({
  windowId: idSchema,
  title: z.string().nullable(),
  subrole: z.string().nullable(),
  bounds: boundsSchema.nullable(),
  main: z.boolean(),
  focused: z.boolean(),
});
const displaySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  bounds: boundsSchema,
  scaleFactor: z.number().finite().positive(),
  primary: z.boolean(),
});
const observationSchema = z.object({
  app: z.object({
    pid: idSchema.positive().nullish(),
    name: z.string().nullish(),
    bundle_id: z.string().nullish(),
  }),
  window: z.object({
    window_id: idSchema.nullish(),
    title: z.string().nullish(),
    bounds: boundsSchema.nullish(),
  }),
  elements: z.array(
    z.object({
      index: idSchema,
      depth: idSchema,
      node: z.object({
        role: z.string().min(1),
        title: z.string().nullish(),
        value: z.string().nullish(),
        actions: z.array(z.string()).optional(),
        states: z.array(z.string()).optional(),
      }),
    }),
  ),
  accessibility: z
    .object({ state: z.literal("unavailable"), reason: z.string() })
    .optional(),
});
const frameSchema = z.object({
  frameId: z.string().min(1),
  mimeType: z.literal("image/png"),
  width: idSchema.positive(),
  height: idSchema.positive(),
  bounds: boundsSchema.nullish(),
});
const resultSchema = z.object({
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("image"),
        mimeType: z.string(),
        data: z.string(),
      }),
    ]),
  ),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});
const mutationNames = new Set([
  "click",
  "type",
  "key",
  "mouse_move",
  "drag",
  "scroll",
  "focus_window",
  "stop_computer_control",
]);
function invalidResult(message: string, actionSent = false): Error {
  return Object.assign(new Error(message), {
    code: "invalid_backend_result",
    actionSent,
  });
}
function parseResult<T>(
  schema: z.ZodType<T>,
  value: unknown,
  operation: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw invalidResult(
      `外部桌面MCP的${operation}结果不符合已声明的协议`,
      mutationNames.has(operation),
    );
  return parsed.data;
}
function actionResult(result: CuToolResult, operation: string, detail: string) {
  const metadata = parseResult(
    z.object({ actionSent: z.boolean() }),
    result.structuredContent,
    operation,
  );
  return { actionSent: metadata.actionSent, detail };
}

/** Provider引用库存连接；命令/env/凭据/重连仍由原MCP服务持有。 */
export interface ComputerUseMcpConnection {
  id: string;
  name: string;
  call(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown>;
}
export interface ComputerUseMcpSource {
  list(context: ToolExecutionContext): Promise<ComputerUseMcpConnection[]>;
}

function tree(
  rows: z.infer<typeof observationSchema>["elements"],
  limits: CuTreeLimits,
): AxNode {
  const first = Array.isArray(rows) ? rows[0] : undefined;
  if (!first || first.depth !== 0)
    throw invalidResult("外部Computer Use MCP没有合法观察根");
  const stack: Array<AxNode | undefined> = [];
  const indexes = new Set<number>();
  let root: AxNode | undefined;
  let previousDepth = -1;
  for (const row of rows) {
    if (
      indexes.has(row.index) ||
      row.depth > previousDepth + 1 ||
      (root && row.depth === 0)
    )
      throw invalidResult("外部Computer Use MCP观察索引/节点结构不合法");
    indexes.add(row.index);
    previousDepth = row.depth;
    if (row.depth > limits.maxDepth) continue;
    const node: AxNode = {
      role: row.node.role,
      index: row.index,
      children: [],
      ...(row.node.title != null
        ? { title: row.node.title.slice(0, limits.titleMaxChars) }
        : {}),
      ...(row.node.value != null
        ? { value: row.node.value.slice(0, limits.valueMaxChars) }
        : {}),
      ...(row.node.actions
        ? { actions: row.node.actions.slice(0, limits.maxActions) }
        : {}),
      ...(row.node.states ? { states: row.node.states } : {}),
    };
    if (row.depth === 0) root = node;
    else {
      const parent = stack[row.depth - 1];
      if (!parent || (parent.children?.length ?? 0) >= limits.maxChildren) {
        stack[row.depth] = undefined;
        stack.length = row.depth + 1;
        continue;
      }
      parent.children ??= [];
      parent.children.push(node);
    }
    stack[row.depth] = node;
    stack.length = row.depth + 1;
  }
  if (!root) throw invalidResult("外部Computer Use MCP观察根缺失");
  return root;
}
export function createMcpComputerUseExecutor(
  connection: ComputerUseMcpConnection,
  execution: () => ToolExecutionContext,
): ComputerUseExecutor {
  const call = async (
    name: string,
    args: Record<string, unknown>,
    context?: CuOperationContext,
  ) => {
    const trusted = execution();
    const signal =
      context && trusted.signal
        ? AbortSignal.any([context.signal, trusted.signal])
        : (context?.signal ?? trusted.signal);
    signal?.throwIfAborted();
    let raw: unknown;
    try {
      raw = await connection.call(name, args, {
        ...trusted,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw Object.assign(
        new Error(
          error instanceof Error ? error.message : "外部桌面MCP调用失败",
        ),
        {
          code: signal?.aborted ? "cancelled" : "mcp_backend_failed",
          actionSent:
            (error as { actionSent?: boolean })?.actionSent ??
            mutationNames.has(name),
        },
      );
    }
    const maxBytes =
      context?.maxOutputBytes ??
      AGENT_GOVERNANCE_DEFAULTS.processMaxOutputBytes;
    if (Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8") > maxBytes)
      throw invalidResult(
        "外部桌面MCP结果超过当前processMaxOutputBytes设置",
        mutationNames.has(name),
      );
    const parsed = parseResult(resultSchema, raw, name);
    const result: CuToolResult = {
      content: parsed.content,
      ...(parsed.structuredContent
        ? { structuredContent: parsed.structuredContent }
        : {}),
      ...(parsed.isError !== undefined ? { isError: parsed.isError } : {}),
    };
    if (result.isError) {
      const error = parseResult(
        z.object({
          code: z.string().min(1),
          actionSent: z.boolean().optional(),
        }),
        result.structuredContent?.error,
        name,
      );
      throw Object.assign(
        new Error(
          result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
        ),
        {
          code: error.code,
          actionSent: error.actionSent ?? mutationNames.has(name),
        },
      );
    }
    return result;
  };
  const structured = (result: CuToolResult) => {
    if (!result.structuredContent)
      throw invalidResult("外部Computer Use MCP缺少结构化结果");
    return result.structuredContent;
  };
  const target = (value: CuTarget, context?: CuOperationContext) =>
    value.kind === "element"
      ? { type: "element", index: value.index }
      : {
          type: "coordinate",
          x: value.x,
          y: value.y,
          frameId: context?.raster?.frameId,
        };
  const perform = async (
    app: ParsedAppRef,
    action: CuInputAction,
    context: CuOperationContext,
  ) => {
    const mapping = {
      focus: "focus_window",
      keys: "key",
      move: "mouse_move",
      drag: "drag",
      scroll: "scroll",
      click: "click",
    };
    const args =
      action.kind === "drag"
        ? { from: target(action.from, context), to: target(action.to, context) }
        : action.kind === "keys"
          ? { keys: action.keys }
          : action.kind === "click"
            ? {
                target: target(action.target, context),
                click_count: action.count,
                button: action.button,
              }
            : "target" in action
              ? {
                  ...action,
                  ...(action.target
                    ? { target: target(action.target, context) }
                    : {}),
                }
              : {};
    const name = mapping[action.kind];
    return actionResult(
      await call(name, { app, ...args }, context),
      name,
      "外部桌面MCP已返回动作结果，请重新观察确认",
    );
  };
  return {
    id: `mcp:${connection.id}`,
    available: true,
    async accessStatus(context) {
      const result = await call("request_access", {}, context);
      const status = parseResult(
        accessSchema,
        result.structuredContent,
        "request_access",
      );
      return {
        accessibility: status.permissionStatus.accessibility,
        screen: status.permissionStatus.screen,
        ...(status.permissionStatus.postEvents !== undefined
          ? { postEvents: status.permissionStatus.postEvents }
          : {}),
        hint: status.hint,
      };
    },
    async listApps(context) {
      return parseResult(
        z.array(appSchema),
        structured(await call("list_apps", {}, context)).apps,
        "list_apps",
      );
    },
    async listWindows(app, context) {
      return parseResult(
        z.array(windowSchema),
        structured(await call("list_windows", { app }, context)).windows,
        "list_windows",
      );
    },
    async listDisplays(context) {
      return parseResult(
        z.array(displaySchema),
        structured(await call("list_displays", {}, context)).displays,
        "list_displays",
      );
    },
    async observe(app, context) {
      const state = parseResult(
        observationSchema,
        structured(await call("get_app_state", { app }, context)),
        "get_app_state",
      );
      const appInfo = state.app,
        window = state.window;
      return {
        app: {
          ...(typeof appInfo.pid === "number" ? { pid: appInfo.pid } : {}),
          ...(appInfo.name ? { name: appInfo.name } : {}),
          ...(appInfo.bundle_id ? { bundleId: appInfo.bundle_id } : {}),
        },
        window: {
          ...(typeof window.window_id === "number"
            ? { windowId: window.window_id }
            : {}),
          ...(window.title ? { title: window.title } : {}),
          ...(window.bounds ? { bounds: window.bounds } : {}),
        },
        root: tree(state.elements, context?.treeLimits ?? CU_AX_DEFAULT_LIMITS),
        treeLimits: context?.treeLimits,
        ...(state.accessibility
          ? {
              accessibility: state.accessibility,
            }
          : {}),
      };
    },
    async capture(app, context): Promise<CuRaster> {
      const result = await call("screenshot", { app }, context);
      const info = parseResult(
        frameSchema,
        result.structuredContent?.image,
        "screenshot",
      );
      const block = result.content.find((value) => value.type === "image");
      if (
        !block ||
        block.type !== "image" ||
        block.mimeType !== "image/png" ||
        !block.data ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          block.data,
        )
      )
        throw invalidResult(
          "外部桌面MCP没有返回合法PNG截图，请检查其预算/能力",
        );
      const bytes = Buffer.from(block.data, "base64");
      const pixelBudget =
        context?.maxOutputBytes ??
        AGENT_GOVERNANCE_DEFAULTS.processMaxOutputBytes;
      let image: ReturnType<typeof readPngWithinBudget>;
      try {
        image = readPngWithinBudget(bytes, pixelBudget);
      } catch (error) {
        if ((error as { code?: string })?.code === "image_budget_exceeded")
          throw error;
        throw invalidResult("外部桌面MCP返回损坏的PNG");
      }
      if (image.width !== info.width || image.height !== info.height)
        throw invalidResult("外部桌面MCP的PNG尺寸与帧元数据不一致");
      return {
        frameId: info.frameId,
        width: info.width,
        height: info.height,
        ...(info.bounds ? { bounds: info.bounds } : {}),
        mimeType: "image/png",
        base64: block.data,
        blackFrame: false,
      };
    },
    async click(app, value, context) {
      return actionResult(
        await call("click", { app, target: target(value, context) }, context),
        "click",
        "外部MCP已返回点击结果",
      );
    },
    async typeText(app, text, value, context) {
      const result = await call(
        "type",
        { app, text, ...(value ? { target: target(value, context) } : {}) },
        context,
      );
      return actionResult(result, "type", "外部MCP已返回输入结果");
    },
    perform,
    async stop() {
      await call("stop_computer_control", {});
    },
  };
}
