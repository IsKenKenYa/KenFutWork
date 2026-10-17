import type { PluginDefinition } from "../../kernel/types.js";
import { detectFreeCadRuntime } from "./runtime.js";
import { CAD_BUNDLE_ID, createCadService } from "./service.js";
import { createCadTools } from "./tools.js";

interface PluginsLike {
  list(): Promise<
    Array<{ id: string; name: string; installed: boolean; enabled?: boolean }>
  >;
}

export function createCadBundleGate(plugins: () => PluginsLike | undefined) {
  return async () => {
    try {
      const registry = plugins();
      if (!registry)
        return {
          ok: false,
          message: "插件列表暂不可用，无法确认 CAD 插件安装状态。",
        };
      const bundle = (await registry.list()).find(
        (entry) => entry.id === CAD_BUNDLE_ID || entry.name === CAD_BUNDLE_ID,
      );
      if (!bundle?.installed)
        return { ok: false, message: "请先在插件市场安装 CAD 插件。" };
      if (bundle.enabled === false)
        return { ok: false, message: "CAD 插件已停用，请在插件市场重新启用。" };
      return { ok: true };
    } catch {
      return { ok: false, message: "无法查询 CAD 插件状态，请稍后重试。" };
    }
  };
}

/** 官方市场 bundle 持有安装态；本插件提供 Definition / Provider / 工具 Consumer。 */
export function createCadPlugin(options?: {
  executable?: string;
}): PluginDefinition {
  return {
    name: "cad",
    inject: ["processSandbox", "settings"],
    apply(ctx) {
      const gate = createCadBundleGate(() => ctx.tryGet("plugins"));
      const service = createCadService({
        sandbox: ctx.get("processSandbox"),
        gate,
        detectRuntime: () => detectFreeCadRuntime(options),
        async resolveLimits(context) {
          if (!context.actor) throw new Error("CAD 设置缺少实例身份。");
          const settings = await ctx
            .get("settings")
            .getInstanceSettings(context.actor, context.actor.instanceId);
          return {
            timeoutMs:
              settings.executeTimeoutMs === 0
                ? null
                : settings.executeTimeoutMs,
            limits: {
              maxOutputBytes: settings.processMaxOutputBytes,
              previewMaxChars: settings.processPreviewMaxChars,
              yieldMs: settings.processYieldMs,
              killGraceMs: settings.processKillGraceMs,
            },
          };
        },
      });
      ctx.on("turn-stopping", async (payload, next) => {
        await next();
        if (payload.runId) service.releaseRun(payload.runId);
      });
      for (const tool of createCadTools(service)) {
        ctx.effect(() =>
          ctx.get("tools").registerDynamic({
            id: `cad.${tool.name}`,
            scope: "shared",
            resolve(run) {
              const handle = run.scopeHandle;
              if (handle?.role !== "main") return null;
              if (
                tool.access !== "read" &&
                handle.describe().sandboxMode === "read-only"
              )
                return null;
              return tool;
            },
          }),
        );
      }
      ctx.effect(() =>
        ctx.get("systemPrompt").register({
          name: "cad",
          order: 310,
          scope: "always",
          async resolve() {
            if (!(await gate()).ok) return null;
            return "CAD 插件：用 cad_status 发现 FreeCAD，用按需 CAD 工具操作独立工程。优先保留可编辑 FCStd，再导出交换文件；不操作用户当前 GUI 文档。复杂建模用完整 cad_run_python source，受当前 Task 执行审批及 OS 沙箱约束。PartDesign 脚本显式设置 Body.Tip 为最终特征，再检查目标对象与数值。基础模块存在不等于任务几何正确；失败后检查错误，不用旧 Shape 或残留文件冒充成功。用 cad_preview 检查真实几何投影的线框 PNG，或导出 SVG/DXF；该预览不是 GUI 着色渲染。";
          },
        }),
      );
    },
  };
}
