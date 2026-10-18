import { z } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import type { ApprovalReviewKind } from "../permissions/approval-review-context.js";
import {
  cadGuiDocumentsInputSchema,
  cadGuiInspectDocumentInputSchema,
} from "./gui-document-contracts.js";
import {
  cadGuiOperationStatusInputSchema,
  cadGuiSetPropertiesInputSchema,
} from "./gui-operation-contracts.js";
import type { CadService, CadToolResult } from "./service.js";
import {
  cadDescribeInputSchema,
  cadExportInputSchema,
  cadOperationsInputSchema,
  cadPreviewInputSchema,
  cadPrimitiveInputSchema,
  cadPythonInputSchema,
  cadStatusSchema,
} from "./tool-contracts.js";

function definition<T extends z.ZodType>(options: {
  name: string;
  description: string;
  schema: T;
  approvalReviewKind?: ApprovalReviewKind;
  execute(
    input: z.output<T>,
    context: ToolExecutionContext,
  ): Promise<CadToolResult>;
}): ToolDefinition {
  return {
    name: options.name,
    description: options.description,
    parameters: z.toJSONSchema(options.schema),
    zodSchema: options.schema,
    scope: "shared",
    exposure: "deferred",
    access: options.approvalReviewKind ? "execute" : "read",
    ...(options.approvalReviewKind
      ? { approvalReviewKind: options.approvalReviewKind }
      : {}),
    async execute(args, context) {
      const parsed = options.schema.safeParse(args);
      if (!parsed.success)
        return {
          isError: true,
          content: [
            { type: "text", text: `CAD 参数不正确：${parsed.error.message}` },
          ],
          structuredContent: { error: { code: "invalid_arguments" } },
        };
      return options.execute(parsed.data, context);
    },
  };
}

export function createCadTools(service: CadService): ToolDefinition[] {
  const epoch = service.activationEpoch;
  return [
    definition({
      name: "cad_status",
      description:
        "检查官方 CAD 插件和已安装 FreeCAD 后台运行时。先查询状态；发现可执行文件不代表所有工作台已通过验收。不会操作当前打开的 FreeCAD 文档。",
      schema: cadStatusSchema,
      execute: (_input, context) => service.status(context),
    }),
    definition({
      name: "cad_gui_status",
      description:
        "查询当前运行的 FreeCAD GUI 实例（目前支持 macOS），返回真实 PID、系统启动时间、内核出生身份与安装路径。只读应用身份，不启动应用、不读取或修改当前文档，不授予该应用 Task 沙箱身份；后台建模仍用其它 CAD 工具。",
      schema: cadStatusSchema,
      execute: (_input, context) => service.guiStatus(context),
    }),
    definition({
      name: "cad_gui_documents",
      description:
        "查询指定 FreeCAD GUI 当前打开文档的名称、文件名、原生 UID、脏状态与活动状态。application 必须来自 cad_gui_status 的完整身份。通过固定宏连接外部应用，按执行权限审批；GUI 不继承 Task OS 沙箱。只读取元数据，不读取几何、不修改、重算、保存或关闭文档；保留事件观察器以返回 bridgeEpoch、每次打开的新 documentHandle 及观察修订。修订只统计已收到事件和查询时元数据差异，不是完整内容版本。Name/Uid/句柄均不授予编辑权限。模型不能提交宏源码、宏路径或连接端点。目前支持 macOS 官方安装包。",
      schema: cadGuiDocumentsInputSchema,
      approvalReviewKind: "cad-gui-inspect",
      execute: (input, context) =>
        service.guiDocuments(input.application, context),
    }),
    definition({
      name: "cad_gui_inspect_document",
      description:
        "读取指定 FreeCAD GUI 文档的对象与直接标量属性。先用 cad_gui_documents 取得完整 application、bridgeEpoch、documentHandle 和两个观察修订，原样填入 expectedApplicationRevision/expectedDocumentRevision；目标已变化时重新查询。省略 objectNames 仅列对象，显式指定对象才读取属性。返回当前值、原生类型、单位维度、只读/不可变标志和表达式；editable 仅表示此类直接标量可进入后续受控修改，不是编辑授权。通过固定宏读取外部应用及其属性 getter，按执行权限审批，GUI 不继承 Task OS 沙箱；不保存、重算或修改工程，不执行模型提交的 Python。",
      schema: cadGuiInspectDocumentInputSchema,
      approvalReviewKind: "cad-gui-inspect",
      execute: (input, context) => service.guiInspectDocument(input, context),
    }),
    definition({
      name: "cad_gui_set_properties",
      description:
        "在当前 FreeCAD GUI 的活动文档中修改直接标量属性，尚不保存文件。先读取文档快照和指定对象属性，原样提供完整应用身份、桥代际、打开句柄、两个预期修订，以及每项 expectedValue/value；Quantity使用内部基础数值及八维单位签名。整批先校验，拒绝只读/不可变、转发属性、表达式绑定目标、枚举和复杂属性；可修改表达式的驱动属性。默认修改后重算，正常提交一条撤销记录；不承诺任意原生回调的事务原子性。外部GUI不继承Task OS沙箱，独立执行审批；仅固定操作，不接模型Python。operationId是持久幂等编号，同一请求重放沿用原编号。返回partial/unknown、停止或超时时，先用cad_gui_operation_status查询同一编号并检查现场，不换新编号盲重试，不自动撤销、保存或关闭用户工程。",
      schema: cadGuiSetPropertiesInputSchema,
      approvalReviewKind: "cad-gui-mutate",
      execute: (input, context) => service.guiSetProperties(input, context),
    }),
    definition({
      name: "cad_gui_operation_status",
      description:
        "读取当前Task内持久CAD操作的状态和原回执。只接受原operationId；不连接、重发或启动FreeCAD，不要求原GUI仍存活。已认领但无有效回执的操作保持unknown；取消请求不等于已回滚。重启、插件停用或Run结束不会删除操作记录。",
      schema: cadGuiOperationStatusInputSchema,
      execute: (input, context) =>
        service.guiOperationStatus(input.operationId, context),
    }),
    definition({
      name: "cad_describe_document",
      description:
        "在 Task 沙箱中打开独立 FCStd 工程，重算并检查对象类型、状态、Shape 有效性、实体数、体积、包围盒与 Body.Tip。源文件不保存；工程恢复会执行 FreeCAD，因此仍按执行权限审批。",
      schema: cadDescribeInputSchema,
      approvalReviewKind: "cad-describe",
      execute: (input, context) =>
        service.execute({ action: "describe", input }, context),
    }),
    definition({
      name: "cad_create_primitive",
      description:
        "在独立 FreeCAD 工程创建可编辑参数化 box/cylinder/sphere/cone，尺寸单位 mm。documentPath 可读取已有工程；始终输出新 FCStd，不覆盖原文件。默认保存到 Task 的 .kfw-cad 独立执行目录。",
      schema: cadPrimitiveInputSchema,
      approvalReviewKind: "cad-primitive",
      execute: (input, context) =>
        service.execute({ action: "primitive", input }, context),
    }),
    definition({
      name: "cad_apply_operations",
      description:
        "在独立 FreeCAD 工程按顺序创建 Body、矩形/圆约束草图、首个 Pad、Pocket、首个 Revolution 或修改尺寸；长度单位 mm，角度单位 deg。轮廓名在同一草图内唯一；origin 为矩形左下角、center 为圆心，均为固定绝对坐标，不自动随其它轮廓改尺寸居中。草图完全约束，驱动尺寸命名为轮廓名_Width/_Height/_Radius。结构化 Pad 限同 Body 首个正向 XY 定长单侧特征；孔草图同时指定 body/supportPad，将局部 Z 以固定表达式绑定该 Pad.Length。Pocket 使用当前 Body.Tip 的该 Pad 为基体，profile 必须是与其绑定且尚未被特征消费的孔草图；mode=depth 必填 depth，through_all 不带 depth。Revolution 限同 Body 首个自由 XY 草图绕本草图局部轴正向单侧旋转，axis=x/y，angle取值(0,360]；不使用任意外部轴。set_dimension 的 width/height/radius 必须带 profile，仅修改唯一且类型匹配的命名驱动尺寸；length 只改固定长度 Pad、depth 只改有限 Pocket，angle 只改固定角 Revolution；length/depth/angle 均不带 profile。拒绝已有表达式、参考或停用尺寸，不解除绑定。修改尺寸保持当前 Tip 和可见性。documentPath只读源工程，outputPath必须是新FCStd；不接管当前GUI文档。data.operations返回实际状态和尺寸；失败不发布最终文件，不承诺中间副作用事务回滚。更广建模形态用cad_run_python，沿用Task权限和审批。",
      schema: cadOperationsInputSchema,
      approvalReviewKind: "cad-operations",
      execute: (input, context) =>
        service.execute({ action: "operations", input }, context),
    }),
    definition({
      name: "cad_export",
      description:
        "重算并验证 FreeCAD 工程后导出新 STEP/STL/OBJ/BREP 或2D SVG/DXF 文件，不覆盖已有文件。可用 objectNames 显式指定几何对象；默认使用依赖图末端几何。SVG/DXF按view投影（默认top）；先检查 Body.Tip 与目标对象，避免导出被替代的历史形状。",
      schema: cadExportInputSchema,
      approvalReviewKind: "cad-export",
      execute: (input, context) =>
        service.execute({ action: "export", input }, context),
    }),
    definition({
      name: "cad_preview",
      description:
        "基于 FreeCAD TechDraw 的真实几何投影生成线框 PNG 预览与 SVG，返回模型可观察的图片并保留 Task 文件。不依赖 Blender 或 GUI，不是着色渲染。view 可为isometric/top/front/right（默认isometric），objectNames可显式选几何；outputPath必须是新PNG文件。先核对Body.Tip。",
      schema: cadPreviewInputSchema,
      approvalReviewKind: "cad-preview",
      execute: (input, context) =>
        service.execute({ action: "preview", input }, context),
    }),
    definition({
      name: "cad_run_python",
      description:
        "在 Task 的真实 OS 沙箱中执行完整 FreeCAD Python source（按当前权限审批），覆盖草图约束、PartDesign、布尔、阵列、TechDraw 和其它已安装 Python 模块。预置 App/FreeCAD、Part、doc、output_directory，可 import 其它模块。documentPath仅读已有工程，新建省略；outputPath必须是新文件，由工具最终发布。中间重开验证用output_directory暂存，最终doc交给工具保存。可选result普通JSON原样放回执data，不自动去敏；stdout私有，大结果/媒体写Task文件返回路径。3D任务设置requireSolids:true，显式body.Tip=最终特征并检查尺寸/体积；2D检查Sketch自身几何，纯草图Body可无Tip/空Shape。无效几何或重算失败不报告成功。任意Python效果受Task权限约束。离屏GUI保存原生显示状态，按需设置最终对象的Visibility；不连接当前可见文档，不保证离屏OpenGL截图，使用cad_preview检查线框。",
      schema: cadPythonInputSchema,
      approvalReviewKind: "cad-python",
      execute: (input, context) =>
        service.execute({ action: "python", input }, context),
    }),
  ].map(
    (tool): ToolDefinition => ({
      ...tool,
      configurationVersion: `cad:${epoch}`,
      execute(args, context) {
        if (service.activationEpoch !== epoch)
          return Promise.resolve({
            isError: true,
            content: [
              { type: "text", text: "CAD 插件已重新装载，请发起新的调用。" },
            ],
            structuredContent: { error: { code: "invocation_revoked" } },
          });
        return tool.execute(args, context);
      },
    }),
  );
}
