/**
 * Computer Use 工具面（ctx.tools 注册，scope: "code"）。
 *
 * 命名 `mcp__computer-use__<action>`：与已照搬的 zcode CUA 渲染链解析约定
 * 一致（`isZCodeCuaToolName` 按名包含 computer-use 命中，连续行自动聚合成
 * 贴底操作组）。Task审批按实际副作用声明：只读发现为read，输入/拉起为execute。
 *
 * 用法纪律写进工具描述（里程碑 1 不注入独立技能文件）：
 * - **a11y 优先**：get_app_state 的文本树是主观察方式，坐标/截图是兜底；
 * - **observe → act → observe**：动作后重新观察确认效果；
 * - **元素索引优先于坐标**；坐标只能引用最近一帧截图。
 */

import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import type { CuInputAction } from "./executor.js";
import type { CuRequestContext, CuToolResult } from "./service.js";
import { parseTarget } from "./target.js";

export const CU_TOOL_PREFIX = "mcp__computer-use__";

/** 市场门控 bundle 的产品 id（plugins/computer-use/）。 */
export const CU_BUNDLE_ID = "kenfutwork-computer-use";

export interface CuGateVerdict {
  ok: boolean;
  message?: string;
}

export interface CuToolDeps {
  backends?: {
    list(context: ToolExecutionContext): Promise<CuToolResult>;
    select(id: string, context: ToolExecutionContext): Promise<CuToolResult>;
  };
  service: {
    requestAccess(context?: CuRequestContext): Promise<CuToolResult>;
    listApps(context?: CuRequestContext): Promise<CuToolResult>;
    listWindows(
      appRef: unknown,
      context?: CuRequestContext,
    ): Promise<CuToolResult>;
    getState(
      appRef: unknown,
      input: { includeScreenshot?: boolean },
      context?: CuRequestContext,
    ): Promise<CuToolResult>;
    screenshot(
      appRef: unknown,
      context?: CuRequestContext,
    ): Promise<CuToolResult>;
    click(
      appRef: unknown,
      rawTarget: unknown,
      runId: string,
      context?: CuRequestContext,
    ): Promise<CuToolResult>;
    typeText(
      appRef: unknown,
      text: string,
      rawTarget: unknown,
      runId: string,
      context?: CuRequestContext,
    ): Promise<CuToolResult>;
    stop(runId: string): Promise<CuToolResult>;
    listDisplays?(context?: CuRequestContext): Promise<CuToolResult>;
    perform?(
      appRef: unknown,
      action: CuInputAction,
      runId: string,
      context?: CuRequestContext,
    ): Promise<CuToolResult>;
  };
  /** 安装态门控（市场 bundle 未安装/停用时拒绝并指路，不摆空壳）。 */
  gate: () => Promise<CuGateVerdict>;
}

const runIdOf = (execCtx: ToolExecutionContext): string => execCtx.runId ?? "";

function projectResult(name: string, result: CuToolResult): CuToolResult {
  const error = result.structuredContent?.error as
    | Record<string, unknown>
    | undefined;
  const structured = { ...result.structuredContent };
  const app =
    structured.app &&
    typeof structured.app === "object" &&
    !Array.isArray(structured.app)
      ? (structured.app as Record<string, unknown>)
      : undefined;
  const bundleId = app?.bundle_id ?? app?.bundleId;
  const image = structured.image as Record<string, unknown> | undefined;
  if (image) {
    const { data: _data, ...metadata } = image;
    structured.image = metadata;
  }
  return {
    ...result,
    canonicalOutput: {
      content: result.content,
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
      ...(result.structuredContent
        ? { structuredContent: result.structuredContent }
        : {}),
    },
    modelContent: [
      ...result.content.map((block) =>
        block.type === "image"
          ? {
              type: "image" as const,
              source_type: "base64" as const,
              mime_type: block.mimeType,
              data: block.data,
            }
          : block,
      ),
      ...(result.structuredContent
        ? [{ type: "text" as const, text: JSON.stringify(structured) }]
        : []),
    ],
    display: {
      kind: "cua",
      schemaVersion: 1,
      toolName: name,
      // 仅来自已确认的后端结果；空locators显式阻止原renderer回退到模型app参数。
      targetApp: {
        schemaVersion: 1,
        ...(typeof app?.name === "string"
          ? { displayName: app.name.slice(0, 512) }
          : {}),
        iconLocators:
          typeof bundleId === "string" &&
          bundleId.length <= 255 &&
          /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(bundleId)
            ? [{ kind: "darwin-bundle-id", value: bundleId }]
            : [],
      },
      status: result.isError ? "failed" : "success",
      text: result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
      structuredContent: JSON.stringify(structured),
      media: result.content
        .filter((block) => block.type === "image")
        .map((block) => ({ mimeType: block.mimeType, data: block.data })),
      ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
      ...(typeof error?.suggested_action === "string"
        ? { suggestedAction: error.suggested_action }
        : {}),
    },
  };
}

async function guarded(
  deps: CuToolDeps,
  run: () => Promise<CuToolResult>,
): Promise<CuToolResult> {
  const gate = await deps.gate();
  if (!gate.ok) {
    return {
      content: [
        {
          type: "text",
          text: `${gate.message ?? "Computer Use 插件当前不可用。"}（plugin_disabled）`,
        },
      ],
      isError: true,
      structuredContent: {
        error: {
          code: "plugin_disabled",
          suggested_action: gate.message ?? "",
        },
      },
    };
  }
  return await run();
}

const APP_REF_SCHEMA = {
  anyOf: [
    { type: "string", description: "bundle id（如 com.apple.calculator）" },
    {
      type: "object",
      description:
        "应用引用：name（显示名，须与 OS 列出的完全一致）/ bundleId / pid 之一，可加 windowId 钉住单窗口",
      properties: {
        name: { type: "string" },
        bundleId: { type: "string" },
        pid: { type: "number" },
        windowId: { type: "number" },
        displayId: {
          type: "string",
          description:
            "整屏目标：单独指定list_displays返回的id，不能与应用标识混用",
        },
      },
    },
  ],
};

const TARGET_SCHEMA = {
  anyOf: [
    {
      type: "object",
      description: "元素索引（首选）：取自最近一次 get_app_state 的树",
      properties: {
        type: { type: "string", enum: ["element"] },
        index: { type: "number" },
      },
      required: ["type", "index"],
    },
    {
      type: "object",
      description:
        "屏幕坐标（兜底）：只能引用最近一次 screenshot/get_app_state 返回的帧；需指明来源帧时带 frameId",
      properties: {
        type: { type: "string", enum: ["coordinate"] },
        x: { type: "number" },
        y: { type: "number" },
        frameId: { type: "string" },
      },
      required: ["type", "x", "y"],
    },
  ],
};

export function createComputerUseTools(deps: CuToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: `${CU_TOOL_PREFIX}request_access`,
      access: "read",
      description:
        "检查 Computer Use 权限（辅助功能/屏幕录制）状态并返回引导。首次使用桌面控制前先调用它；permissionStatus 为 denied 时按提示去系统设置授权。",
      scope: "code",
      parameters: { type: "object", properties: {} },
      execute: async (_args, execCtx) =>
        guarded(deps, () => deps.service.requestAccess(execCtx)),
    },
    {
      name: `${CU_TOOL_PREFIX}list_apps`,
      access: "read",
      description:
        "列出当前运行的应用（pid/bundle_id/名称/是否活跃）。要操作某个应用前先看它的准确标识——显示名必须逐字复制 OS 列出的名字，不要翻译或简写。",
      scope: "code",
      parameters: { type: "object", properties: {} },
      execute: async (_args, execCtx) =>
        guarded(deps, () => deps.service.listApps(execCtx)),
    },
    {
      name: `${CU_TOOL_PREFIX}list_windows`,
      access: "read",
      description:
        "列出某应用的窗口（window_id/标题/subrole/main/focused）。多窗口应用要先选窗口；没有 subrole 的行是合成表面，不可绑定。",
      scope: "code",
      parameters: {
        type: "object",
        properties: { app: APP_REF_SCHEMA },
        required: ["app"],
      },
      execute: async (args, execCtx) =>
        guarded(deps, () => deps.service.listWindows(args.app, execCtx)),
    },
    {
      name: `${CU_TOOL_PREFIX}get_app_state`,
      description:
        "观察应用的无障碍树（首选观察方式，纯文本、不需要截图）。返回元素行 [index] 角色 标题 (状态) actions=[…]；后续动作用元素索引寻址。绑定未运行的应用会自动拉起它。include_screenshot=true 时附带当前窗口截图（坐标动作需先有帧）。",
      scope: "code",
      parameters: {
        type: "object",
        properties: {
          app: APP_REF_SCHEMA,
          include_screenshot: { type: "boolean" },
        },
        required: ["app"],
      },
      execute: async (args, execCtx) =>
        guarded(deps, () =>
          deps.service.getState(
            args.app,
            {
              includeScreenshot: args.include_screenshot === true,
            },
            execCtx,
          ),
        ),
    },
    {
      name: `${CU_TOOL_PREFIX}screenshot`,
      description:
        "截取目标应用当前窗口的截图（视觉兜底：a11y 树看不到的自绘/画布内容才用它）。返回帧的 frameId 与边界；坐标动作只能引用最近一帧。",
      scope: "code",
      parameters: {
        type: "object",
        properties: { app: APP_REF_SCHEMA },
        required: ["app"],
      },
      execute: async (args, execCtx) =>
        guarded(deps, () => deps.service.screenshot(args.app, execCtx)),
    },
    {
      name: `${CU_TOOL_PREFIX}click`,
      description:
        "点击元素（首选索引寻址）或屏幕坐标（兜底，须引用最近截图帧）。动作后重新观察确认效果——成功下发≠界面已变化。",
      scope: "code",
      parameters: {
        type: "object",
        properties: {
          app: APP_REF_SCHEMA,
          target: TARGET_SCHEMA,
          click_count: {
            type: "integer",
            enum: [1, 2],
            description: "默认 1；2=双击",
          },
          button: { type: "string", enum: ["left", "right", "middle"] },
        },
        required: ["app", "target"],
      },
      execute: async (args, execCtx) =>
        guarded(deps, () =>
          args.click_count === 2 ||
          args.button === "right" ||
          args.button === "middle"
            ? deps.service.perform!(
                args.app,
                {
                  kind: "click",
                  target: parseTarget(args.target),
                  button:
                    args.button === "right" || args.button === "middle"
                      ? args.button
                      : "left",
                  count: args.click_count === 2 ? 2 : 1,
                },
                runIdOf(execCtx),
                execCtx,
              )
            : deps.service.click(
                args.app,
                args.target,
                runIdOf(execCtx),
                execCtx,
              ),
        ),
    },
    {
      name: `${CU_TOOL_PREFIX}type`,
      description:
        "向目标输入文本（可带元素索引定位输入框；缺省打到当前焦点）。Unicode/中文走系统剪贴板通道，输入完成后恢复原剪贴板内容。",
      scope: "code",
      parameters: {
        type: "object",
        properties: {
          app: APP_REF_SCHEMA,
          text: { type: "string" },
          target: TARGET_SCHEMA,
        },
        required: ["app", "text"],
      },
      execute: async (args, execCtx) =>
        guarded(deps, () =>
          deps.service.typeText(
            args.app,
            String(args.text ?? ""),
            args.target,
            runIdOf(execCtx),
            execCtx,
          ),
        ),
    },
    {
      name: `${CU_TOOL_PREFIX}stop_computer_control`,
      description:
        "停止桌面控制并释放租约（kill switch）。任务完成、用户要求停止、或遇到不可重试错误时立即调用。",
      scope: "code",
      parameters: { type: "object", properties: {} },
      execute: async (_args, execCtx) =>
        guarded(deps, () => deps.service.stop(runIdOf(execCtx))),
    },
  ];
  const inputTool = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    action: (args: Record<string, unknown>) => CuInputAction,
  ): ToolDefinition => ({
    name: `${CU_TOOL_PREFIX}${name}`,
    scope: "code",
    description,
    parameters: {
      type: "object",
      properties: { app: APP_REF_SCHEMA, ...properties },
      required: ["app", ...required],
    },
    execute: async (args, context) =>
      guarded(deps, async () => {
        if (!deps.service.perform) throw new Error("后端不支持完整输入原语");
        return deps.service.perform(
          args.app,
          action(args),
          runIdOf(context),
          context,
        );
      }),
  });
  tools.push({
    name: `${CU_TOOL_PREFIX}list_displays`,
    access: "read",
    description:
      "发现全部显示器：返回全局逻辑边界（可能为负）、缩放比例和主屏标识。",
    scope: "code",
    parameters: { type: "object", properties: {} },
    execute: async (_args, context) =>
      guarded(deps, () => deps.service.listDisplays!(context)),
  });
  tools.push(
    inputTool(
      "mouse_move",
      "把鼠标移动到最近截图中的坐标。",
      { target: TARGET_SCHEMA },
      ["target"],
      (args) => ({ kind: "move", target: parseTarget(args.target) }),
    ),
  );
  tools.push(
    inputTool(
      "drag",
      "在最近截图中的两个坐标间拖拽；完成或取消时释放按钮。",
      { from: TARGET_SCHEMA, to: TARGET_SCHEMA },
      ["from", "to"],
      (args) => ({
        kind: "drag",
        from: parseTarget(args.from),
        to: parseTarget(args.to),
      }),
    ),
  );
  tools.push(
    inputTool(
      "scroll",
      "滚动目标窗口；amount 为系统滚轮步数，实际距离由系统决定。",
      {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "integer", minimum: 1 },
        target: TARGET_SCHEMA,
      },
      ["direction", "amount"],
      (args) => {
        if (
          !["up", "down", "left", "right"].includes(String(args.direction)) ||
          !Number.isSafeInteger(args.amount) ||
          Number(args.amount) <= 0
        )
          throw new Error("滚动需要合法方向和正整数步数");
        return {
          kind: "scroll",
          direction: args.direction as "up" | "down" | "left" | "right",
          amount: Number(args.amount),
          ...(args.target ? { target: parseTarget(args.target) } : {}),
        };
      },
    ),
  );
  tools.push(
    inputTool(
      "key",
      "按下并释放组合键；例如 [command, a]、[ctrl, shift, s]、[Enter]。",
      {
        keys: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
        },
      },
      ["keys"],
      (args) => {
        if (
          !Array.isArray(args.keys) ||
          !args.keys.length ||
          !args.keys.every((key) => typeof key === "string" && key.length)
        )
          throw new Error("keys 必须是非空按键列表");
        return { kind: "keys", keys: args.keys };
      },
    ),
  );
  tools.push(
    inputTool(
      "focus_window",
      "按应用和windowId激活目标窗口；使用list_windows返回的标识。",
      {},
      [],
      () => ({ kind: "focus" }),
    ),
  );
  const backends = deps.backends;
  if (backends) {
    tools.push({
      name: `${CU_TOOL_PREFIX}list_backends`,
      access: "read",
      description:
        "列出实际已装配的桌面后端；外部MCP引用原库存连接，不复制启动配置。",
      scope: "code",
      parameters: { type: "object", properties: {} },
      execute: async (_args, context) =>
        guarded(deps, () => backends.list(context)),
    });
    tools.push({
      name: `${CU_TOOL_PREFIX}select_backend`,
      description:
        "选择list_backends给出的桌面实现。输入进行中或其它Run持有控制权时拒绝；切换后必须重新观察，旧帧不能复用。",
      scope: "code",
      parameters: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 } },
        required: ["id"],
      },
      execute: async (args, context) =>
        guarded(deps, () => backends.select(String(args.id ?? ""), context)),
    });
  }
  return tools.map((definition) => ({
    ...definition,
    exposure: "deferred",
    access: definition.access ?? "execute",
    projectArguments: (args) =>
      definition.name === `${CU_TOOL_PREFIX}key` &&
      Array.isArray(args.keys) &&
      args.keys.every((key) => typeof key === "string")
        ? { ...args, key: args.keys.join("+") }
        : args,
    execute: async (args, context) => {
      if (!context.runId || (context.delegationDepth ?? 0) > 0)
        return {
          isError: true,
          content: [{ type: "text", text: "桌面控制需要可信主Run上下文" }],
          structuredContent: { error: { code: "context_required" } },
        };
      try {
        return projectResult(
          definition.name,
          (await definition.execute(args, context)) as CuToolResult,
        );
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          structuredContent: {
            error: { code: "invalid_target", actionSent: false },
          },
        };
      }
    },
  }));
}
