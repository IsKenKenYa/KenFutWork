import { resolveSandboxDir } from "../../agent/sandbox-dir.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import { resolveInsideRoot } from "../../utils/inside-root.js";
import type { AdminService } from "../admin/admin-service.js";
import type { RequestAuthenticator } from "../auth/types.js";
import type { PluginRegistryService } from "./plugin-registry-service.js";

/**
 * `install_plugin` 工具：把**工作目录里的插件 bundle** 安装到本实例（创造模式的插件产物收尾）。
 *
 * 三个硬约束（缺一不可，都在这里显式表达）：
 * 1. **管理员门**：插件会加载并执行第三方代码，安装是实例级危险操作——与
 *    `/api/plugins/install` 同一条 admin 门，非管理员直接拒绝（不静默降级）；
 * 2. **落点**：bundle 目录必须在本轮 run 的沙箱工作目录内（`resolveInsideRoot` 防 `../`），
 *    目录由 `resolveSandboxDir` 解析（与 agent/git 同一处口径）；
 * 3. **兼容性门禁**：仍有 PluginRegistryService 负责（本工具不绕过它）。
 *
 * 抽成工厂便于单测：只依赖 registry / auth / admin 三个接口。
 */
export function createInstallPluginTool(options: {
  registry: PluginRegistryService;
  auth: RequestAuthenticator;
  admin: AdminService;
  sandboxRoot?: string | undefined;
  canvasWorkDirs?: Record<string, string> | undefined;
  /** 项目绑定的本机工作目录（`projects.work_dir`）；界面绑定优先于环境变量映射。 */
  projectWorkDirLoader?:
    | ((canvasId: string) => Promise<string | null>)
    | undefined;
  /** 安装期生命周期脚本：默认拒绝（与 HTTP 路由同口径），工具不给模型开这个口子。 */
  allowLifecycleScripts?: boolean;
}): ToolDefinition {
  return {
    name: "install_plugin",
    description:
      "把**工作目录里的插件 bundle 目录**安装到本实例（需要管理员权限）。用于「创造」模式产出的插件产物：先用 write_file 在工作目录写好 bundle（package.json 里声明 kenfutwork.bundle 或 dsh.bundle），再调用本工具安装。安装前会跑兼容性门禁，不通过会返回原因。",
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
      const relativePath = String(args.path ?? "").trim();
      if (!relativePath) {
        throw new Error(
          "install_plugin 需要 path（相对工作目录的 bundle 目录）。",
        );
      }
      if (!execCtx.canvasId) {
        throw new Error(
          "当前执行上下文缺少画布，无法定位工作目录（install_plugin 需要 run 绑定项目）。",
        );
      }
      const user = execCtx.accessToken
        ? await options.auth
            .authenticate({
              headers: { authorization: `Bearer ${execCtx.accessToken}` },
            })
            .catch(() => null)
        : null;
      if (!user) {
        throw new Error("当前执行上下文缺少用户凭据，无法安装插件。");
      }
      try {
        await options.admin.requireAdmin(user);
      } catch {
        throw new Error(
          "安装插件需要管理员权限（插件会加载并执行第三方代码），请让管理员在插件市场操作。",
        );
      }

      const boundWorkDir = options.projectWorkDirLoader
        ? await options.projectWorkDirLoader(execCtx.canvasId).catch(() => null)
        : null;
      const sandboxDir = resolveSandboxDir(
        execCtx.canvasId,
        options.sandboxRoot,
        boundWorkDir ?? options.canvasWorkDirs?.[execCtx.canvasId],
      );
      const bundleDir = resolveInsideRoot(sandboxDir, relativePath);

      try {
        const result = await options.registry.install({
          allowLifecycleScripts: options.allowLifecycleScripts ?? false,
          url: bundleDir,
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
              ? `（门禁报告：${JSON.stringify(report).slice(0, 500)}）`
              : ""
          }`,
        );
      }
    },
  };
}
