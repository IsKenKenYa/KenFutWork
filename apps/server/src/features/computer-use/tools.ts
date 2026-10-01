/**
 * Computer Use 工具面（ctx.tools 注册，scope: "code"）。
 *
 * 命名 `mcp__computer-use__<action>`：与已照搬的 zcode CUA 渲染链解析约定
 * 一致（`isZCodeCuaToolName` 按名包含 computer-use 命中，连续行自动聚合成
 * 贴底操作组），且天然落入 permissions 的 `/^mcp__/` 危险工具审批档。
 *
 * 用法纪律写进工具描述（里程碑 1 不注入独立技能文件）：
 * - **a11y 优先**：get_app_state 的文本树是主观察方式，坐标/截图是兜底；
 * - **observe → act → observe**：动作后重新观察确认效果；
 * - **元素索引优先于坐标**；坐标只能引用最近一帧截图。
 */

import type { ToolDefinition, ToolExecutionContext } from "../../kernel/types.js";
import type { CuToolResult } from "./service.js";

export const CU_TOOL_PREFIX = "mcp__computer-use__";

/** 市场门控 bundle 的产品 id（plugins/computer-use/）。 */
export const CU_BUNDLE_ID = "kenfutwork-computer-use";

export interface CuGateVerdict {
  ok: boolean;
  message?: string;
}

export interface CuToolDeps {
  service: {
    requestAccess(): Promise<CuToolResult>;
    listApps(): Promise<CuToolResult>;
    listWindows(appRef: unknown): Promise<CuToolResult>;
    getState(
      appRef: unknown,
      input: { includeScreenshot?: boolean },
    ): Promise<CuToolResult>;
    screenshot(appRef: unknown): Promise<CuToolResult>;
    click(appRef: unknown, rawTarget: unknown, runId: string): Promise<CuToolResult>;
    typeText(
      appRef: unknown,
      text: string,
      rawTarget: unknown,
      runId: string,
    ): Promise<CuToolResult>;
    stop(runId: string): Promise<CuToolResult>;
  };
  /** 安装态门控（市场 bundle 未安装/停用时拒绝并指路，不摆空壳）。 */
  gate: () => Promise<CuGateVerdict>;
}

const runIdOf = (execCtx: ToolExecutionContext): string =>
  execCtx.runId ?? "run-unknown";

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
        error: { code: "plugin_disabled", suggested_action: gate.message ?? "" },
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
      description: "应用引用：name（显示名，须与 OS 列出的完全一致）/ bundleId / pid 之一，可加 windowId 钉住单窗口",
      properties: {
        name: { type: "string" },
        bundleId: { type: "string" },
        pid: { type: "number" },
        windowId: { type: "number" },
      },
    },
  ],
};

const TARGET_SCHEMA = {
  anyOf: [
    {
      type: "object",
      description: "元素索引（首选）：取自最近一次 get_app_state 的树",
      properties: { type: { type: "string", enum: ["element"] }, index: { type: "number" } },
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
      description:
        "检查 Computer Use 权限（辅助功能/屏幕录制）状态并返回引导。首次使用桌面控制前先调用它；permissionStatus 为 denied 时按提示去系统设置授权。",
      scope: "code",
      parameters: { type: "object", properties: {} },
      execute: async (_args, execCtx) =>
        guarded(deps, () => deps.service.requestAccess()),
    },
    {
      name: `${CU_TOOL_PREFIX}list_apps`,
      description:
        "列出当前运行的应用（pid/bundle_id/名称/是否活跃）。要操作某个应用前先看它的准确标识——显示名必须逐字复制 OS 列出的名字，不要翻译或简写。",
      scope: "code",
      parameters: { type: "object", properties: {} },
      execute: async (_args, execCtx) => guarded(deps, () => deps.service.listApps()),
    },
    {
      name: `${CU_TOOL_PREFIX}list_windows`,
      description:
        "列出某应用的窗口（window_id/标题/subrole/main/focused）。多窗口应用要先选窗口；没有 subrole 的行是合成表面，不可绑定。",
      scope: "code",
      parameters: {
        type: "object",
        properties: { app: APP_REF_SCHEMA },
        required: ["app"],
      },
      execute: async (args, execCtx) =>
        guarded(deps, () => deps.service.listWindows(args.app)),
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
          deps.service.getState(args.app, {
            includeScreenshot: args.include_screenshot === true,
          }),
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
        guarded(deps, () => deps.service.screenshot(args.app)),
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
          click_count: { type: "number", description: "默认 1；2=双击" },
        },
        required: ["app", "target"],
      },
      execute: async (args, execCtx) =>
        guarded(deps, () =>
          deps.service.click(args.app, args.target, runIdOf(execCtx)),
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
  return tools;
}
