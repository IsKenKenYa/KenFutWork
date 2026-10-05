import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import { resolveSandboxDir } from "../../agent/sandbox-dir.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import { resolveInsideRoot } from "../../utils/inside-root.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import { createScopedBundleSource } from "./bundle-source.js";
import type { PluginRegistryService } from "./plugin-registry-service.js";

/**
 * `install_plugin` 工具：把**工作目录里的插件 bundle** 安装到本实例（创造模式的插件产物收尾）。
 *
 * 三个硬约束（缺一不可，都在这里显式表达）：
 * 1. **实例归属**：调用者必须来自可信的本地实例，执行仍经过工具审批；
 * 2. **落点**：bundle 目录必须在本轮 run 的沙箱工作目录内（`resolveInsideRoot` 防 `../`），
 *    目录由 `resolveSandboxDir` 解析（与 agent/git 同一处口径）；
 * 3. **兼容性门禁**：仍有 PluginRegistryService 负责（本工具不绕过它）。
 *
 * 抽成工厂便于单测：只依赖 registry / localInstance 三个接口。
 */
export function createInstallPluginTool(options: {
  registry: PluginRegistryService;
  localInstance: LocalInstanceService;
  sandboxRoot?: string | undefined;
  canvasWorkDirs?: Record<string, string> | undefined;
  /** 项目绑定的本机工作目录（`projects.work_dir`）；界面绑定优先于环境变量映射。 */
  projectWorkDirLoader?:
    | ((instanceId: string, canvasId: string) => Promise<string | null>)
    | undefined;
  /** 安装期生命周期脚本：默认拒绝（与 HTTP 路由同口径），工具不给模型开这个口子。 */
  allowLifecycleScripts?: boolean;
}): ToolDefinition {
  return {
    name: "install_plugin",
    access: "execute",
    exposure: "deferred",
    description:
      "把工作目录里的插件 bundle 安装到本实例。生成并检查 bundle 文件后调用；package.json 需声明 kenfutwork.bundle 或 dsh.bundle。安装前会校验兼容性。",
    scope: "shared",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "相对工作目录（沙箱根）的 bundle 目录，如 my-plugin",
        },
      },
      required: ["path"],
    },
    execute: async (args, execCtx: ToolExecutionContext) => {
      const scope = execCtx.scopeHandle;
      const relativePath = String(args.path ?? "").trim();
      if (!relativePath) {
        throw new Error(
          "install_plugin 需要 path（相对工作目录的 bundle 目录）。",
        );
      }
      if (!scope && (execCtx.codeApproval || execCtx.taskWorkContext))
        throw new Error("Code 安装插件必须有明确的 Task 工作域。");
      if (!scope && !execCtx.canvasId) {
        throw new Error(
          "当前执行上下文缺少画布，无法定位工作目录（install_plugin 需要 run 绑定项目）。",
        );
      }
      if (
        scope &&
        (scope.describe().sandboxMode === "read-only" ||
          scope.role === "explore" ||
          scope.role === "review")
      )
        throw new Error("只读 Code 工作域不能安装插件。");
      const actor = execCtx.actor;
      if (!actor) throw new Error("当前工具调用缺少可信本地实例上下文。");
      await options.localInstance.resolve(actor);
      if (scope && scope.describe().instanceId !== actor.instanceId) {
        throw new Error("插件安装工作域不属于当前本地实例。");
      }

      let bundleDir: string;
      if (scope) {
        bundleDir = await scope.resolvePath(relativePath, "read");
        if (scope.describe().sandboxMode === "read-only")
          throw new Error("只读 Code 工作域不能安装插件。");
      } else {
        const canvasId = execCtx.canvasId;
        if (!canvasId) throw new Error("当前执行上下文缺少可视化 Canvas。");
        const boundWorkDir = options.projectWorkDirLoader
          ? await options.projectWorkDirLoader(actor.instanceId, canvasId)
          : null;
        const sandboxDir = resolveSandboxDir(
          canvasId,
          options.sandboxRoot,
          boundWorkDir ?? options.canvasWorkDirs?.[canvasId],
        );
        bundleDir = resolveInsideRoot(sandboxDir, relativePath);
      }

      try {
        const source = scope
          ? createScopedBundleSource(scope, execCtx.signal)
          : null;
        const localSource =
          source && scope
            ? {
                ...source,
                resolvePath: async (path: string) => {
                  const resolved = await source.resolvePath(path);
                  if (scope.describe().sandboxMode === "read-only")
                    throw new Error("Code 工作域已收紧为只读，安装被拒绝。");
                  return resolved;
                },
              }
            : null;
        const result = await options.registry.install({
          allowLifecycleScripts: options.allowLifecycleScripts ?? false,
          url: bundleDir,
          ...(localSource ? { localSource } : {}),
        });
        return {
          installed: true,
          id: result.installed.id,
          name: result.installed.name,
          version: result.installed.version,
          hint: "插件已安装到本实例并启用；用户可在「插件市场 · 已安装」看到。",
        };
      } catch (error) {
        // 兼容性门禁的报告要原样带给模型，否则它不知道该怎么改
        const report = (error as { report?: unknown }).report;
        throw new Error(
          `安装失败：${error instanceof Error ? error.message : String(error)}${
            report
              ? `（门禁报告：${JSON.stringify(report).slice(0, scope?.backend.limits.codeReadPageCharacters ?? AGENT_GOVERNANCE_DEFAULTS.codeReadPageCharacters)}）`
              : ""
          }`,
        );
      }
    },
  };
}
