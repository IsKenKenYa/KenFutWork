import { resolveDesktopDataDir } from "../../desktop/paths.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { PLUGIN_STATE_LIFECYCLE_CAPABILITY } from "../plugins/state-lifecycle.js";
import { createCadGuiOperationStore } from "./gui-operation-store.js";
import { detectFreeCadRuntime } from "./runtime.js";
import {
  CAD_BUNDLE_ID,
  CAD_PLUGIN_INSTALLATION_ID,
  createCadService,
} from "./service.js";
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
        (entry) =>
          entry.id === CAD_PLUGIN_INSTALLATION_ID &&
          entry.name === CAD_BUNDLE_ID,
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
    inject: ["processSandbox", "settings", "capabilities"],
    apply(ctx) {
      const gate = createCadBundleGate(() => ctx.tryGet("plugins"));
      const service = createCadService({
        sandbox: ctx.get("processSandbox"),
        guiOperationStore: createCadGuiOperationStore({
          rootDirectory: resolveDesktopDataDir({
            env: { KENFUTWORK_DATA_DIR: ctx.env.desktopDataDir },
          }),
        }),
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
      const registrations: Array<() => void> = [];
      const removeTools = () => {
        for (const dispose of registrations.splice(0)) dispose();
      };
      const refreshTools = () => {
        removeTools();
        if (!service.activationAvailable) return;
        for (const tool of createCadTools(service)) {
          registrations.push(
            ctx.get("tools").registerDynamic({
              id: `cad.${tool.name}`,
              scope: "shared",
              configurationVersion: `cad:${service.activationEpoch}`,
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
      };
      ctx.effect(() =>
        ctx.get("capabilities").register(PLUGIN_STATE_LIFECYCLE_CAPABILITY, {
          id: "cad:active-operations",
          value: {
            onStateRevoking(
              event: Parameters<
                NonNullable<typeof service.pluginLifecycle.onStateRevoking>
              >[0],
            ) {
              const epoch = service.activationEpoch;
              const pending = service.pluginLifecycle.onStateRevoking?.(event);
              if (epoch !== service.activationEpoch) removeTools();
              return pending;
            },
            afterStateChanged(
              event: Parameters<
                NonNullable<typeof service.pluginLifecycle.afterStateChanged>
              >[0],
            ) {
              const epoch = service.activationEpoch;
              service.pluginLifecycle.afterStateChanged?.(event);
              if (epoch !== service.activationEpoch) refreshTools();
            },
          },
        }),
      );
      ctx.effect(() => () => service.dispose());
      ctx.on("turn-stopping", async (payload, next) => {
        await next();
        if (payload.runId) await service.releaseRun(payload.runId);
      });
      ctx.effect(() => {
        refreshTools();
        return removeTools;
      });
      ctx.effect(() =>
        ctx.get("systemPrompt").register({
          name: "cad",
          order: 310,
          scope: "always",
          async resolve() {
            if (!service.activationAvailable) return null;
            if (!(await gate()).ok) return null;
            return "CAD 插件：用 cad_status 发现 FreeCAD，用按需 CAD 工具操作独立工程。Body、矩形/圆约束草图、基础正向Pad、绑定孔草图及有限/贯穿Pocket、绕草图局部X/Y轴的首个固定角Revolution、Body的fuse/cut/common布尔、显式选边圆角/等距倒角、线性/环形阵列与尺寸修改优先用cad_apply_operations（长度mm、角度deg），复杂操作再用cad_run_python；create_boolean显式指定body/toolBodies/operation，不复用已归属其它Boolean的工具Body，不以静态Shape替代参数链；固定坐标不等于相对居中。documentPath仅读已有工程，新建省略；outputPath是由工具发布的新文件，中间验证用output_directory，最终doc交给工具保存。需要选边时先用cad_describe_document的edges:{objectName,offset,limit}读取真实EdgeN与全局mm几何，沿edgePage.nextOffset分页；几何改变后重新读取，不猜永久边号。create_fillet/create_chamfer显式指定body、当前Tip的base、edges及radius/size；混入原生忽略的平滑边会整体拒绝。set_dimension的草图radius带profile，Fillet的radius和等距Chamfer的size不带profile。create_linear_pattern/create_polar_pattern用同Body上游Pad/Pocket/Revolution作original、草图主轴作direction/axis，当前Tip作为支撑；occurrences含原件，length为首末总距离，angle为正向总角度。允许多实体时保留全部副本，遵循Body.AllowCompound。批改已有阵列用set_pattern_parameters，保留表达式联动与后继引用，不把原生截断或丢件当完成。后台修饰工程使用官方完整拓扑名称保留TNP（UseHasher=false），转换会重算工作副本，选边几何变化或下游失效均拒绝发布。优先保留可编辑 FCStd，再导出交换文件；后台工具只操作独立工程；查询当前GUI文档先用cad_gui_status取得完整应用身份，再用cad_gui_documents读取元数据。查询会向外部GUI加载固定宏、改变文件对话框工作目录，按执行权限审批；不会保存、关闭或修改文档，Name/Uid不是编辑授权句柄。取得文档快照后，用cad_gui_inspect_document列对象，再显式指定objectNames读取标量值、单位维度、只读标志与表达式；两个expected修订和bridgeEpoch/documentHandle均来自最新快照，过期时重新查询。属性读取仍会调用文档getter，不是沙箱内的纯文件读取。当前活动文档的直接标量修改用cad_gui_set_properties，先传最新快照与expectedValue；表达式仅改驱动属性，不解除绑定。需要当前内存文档的独立FCStd时用cad_gui_copy_document，目标可非活动；GUI只写固定私有副本，宿主再按Task权限发布新文件，outputPath不得覆盖。copied仅表示私有副本，published才是Task可用文件，未发布不交付私有路径。复制不保存源、不重算或修复几何，首期外部依赖/引用及无法确认的链接会拒绝；序列化可调用文档provider。发布后可用cad_describe_document核验副本，再交给后台Python或交换导出。相同请求沿用operationId；停止、partial或unknown先用cad_gui_operation_status查原编号及发布状态，不换编号盲重试；状态查询不连接或重发FreeCAD。属性写入正常提交留撤销记录；需显式撤销自身属性操作时，先用cad_gui_operation_status确认sourceOperationId为committed且有undoProvenance/snapshot，再用cad_gui_undo_operation发起新的operationId。应用身份沿用原操作，bridgeEpoch/documentHandle和两个expected修订严格沿用原提交snapshot，不能用新inspect刷新旧撤销前提。新Run按当前Task的scope/branch代际和权限审批，旧来源只证明历史归属。撤销仅调用一次doc.undo，不重算、redo、保存或关闭；pending或外部引用方等前提不符会拒绝，partial不自动补偿。同编号终态重放不依赖原修改记录或GUI；unknown继续查询同编号，不重发。覆盖保存源文件仍未接入。GUI不继承Task OS沙箱；cad_run_python仍只在后台Task审批与OS沙箱内执行。Assembly可用AssemblyApp与JointObject，创建完整官方Joint及ViewProvider；显式solve返回0后核对连接器位置/方向和固定基准，不用preSolve或旧Shape代替求解成功。CAM先建立完整Job、stock和刀具控制器，再生成真实刀路并调用指定后处理；export可能返回文本分段，须写Task新NC并核对实际运动、深度、单位、进给和主轴，非空文本不代表有切削。FEM可用后台Python接ObjectsFem、Gmsh和CalculiX；几何有效不代表分析正确，脚本须核验材料/载荷、实际新网格/新结果及完整有限位移应力数组。随包二进制从App.getHomePath()/bin定位，中间文件写output_directory，不改用户全局偏好或复用旧结果冒充成功。Python三维任务设置requireSolids:true，PartDesign明确Body.Tip为最终特征并检查数值；2D检查Sketch自身几何，纯草图Body可无Tip/空Shape。失败后检查错误，不用旧Shape或残留文件冒充成功。cad_preview提供真实线框PNG，SVG/DXF保留交换尺寸；预览不是GUI着色渲染。";
          },
        }),
      );
    },
  };
}
