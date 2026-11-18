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
import { cadGuiCopyDocumentInputSchema } from "./gui-document-copy-contracts.js";
import { cadGuiSaveDocumentInputSchema } from "./gui-document-save-contracts.js";
import {
  cadGuiOperationStatusInputSchema,
  cadGuiSetPropertiesInputSchema,
} from "./gui-operation-contracts.js";
import { cadGuiUndoOperationInputSchema } from "./gui-undo-contracts.js";
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
      name: "cad_gui_copy_document",
      description:
        "将指定 FreeCAD GUI 当前内存文档复制为新的 Task FCStd 文件，不重算或保存源文件。先用 cad_gui_documents 取得完整应用/桥/文档句柄和两个预期修订；目标可为非活动文档。operationId用于持久幂等，同一请求重放沿用原编号。GUI只向KFW私有操作目录调用原生saveCopy，随后宿主按当前Task目录权限发布到outputPath（默认Task的.kfw-cad/gui-snapshots/编号.FCStd），绝不覆盖已有文件。外部GUI不继承Task OS沙箱，序列化可能调用文档provider，独立执行审批；不接模型Python/私有路径。首期拒绝外部依赖或引用及无法可靠解释的链接，避免保存通知影响其它工程。copied只表示私有副本，published才表示Task文件发布完成；unknown/partial/停止后先查cad_gui_operation_status，不换编号盲重试。发布文件可继续交给cad_describe_document/cad_run_python/cad_export处理；复制未验证几何有效性，保留源的touched/错误状态。",
      schema: cadGuiCopyDocumentInputSchema,
      approvalReviewKind: "cad-gui-copy",
      execute: (input, context) => service.guiCopyDocument(input, context),
    }),
    definition({
      name: "cad_gui_save_document",
      description:
        "显式保存当前活动FreeCAD文档到已有FCStd原路径。完整应用身份、桥代际、句柄、两个expected修订和expectedFileName均来自最新文档快照。宿主按当前Task写权限授权规范化文件与备份所在父目录，固定宏只调用一次App.save；不另存、重算、关闭、撤销或清GUI未保存标记，外部GUI不继承Task OS沙箱。operationId用于持久幂等，同一请求沿用原编号；保存异常可能已更新文件，partial/unknown/停止后先查同编号，禁止自动重试或补偿。未确认结束的写域跨重启继续阻止相交文件恢复。未保存文档请用cad_gui_copy_document。",
      schema: cadGuiSaveDocumentInputSchema,
      approvalReviewKind: "cad-gui-save",
      execute: (input, context) => service.guiSaveDocument(input, context),
    }),
    definition({
      name: "cad_gui_undo_operation",
      description:
        "显式撤销当前Task中自身已确认提交的FreeCAD属性修改。先用cad_gui_operation_status查原sourceOperationId，只有committed且有undoProvenance和snapshot的操作可用；本次operationId必须是新的编号。完整application来自原应用身份，bridgeEpoch/documentHandle及两个expected修订必须沿用原提交snapshot，不能用新inspect刷新旧撤销前提。原操作后发生编辑、保存或undo/redo等观察事件、历史或值变化时拒绝；检查现场，不换编号绕过。宿主从Task私有记录冻结原证明，模型不能提供证明、事务名、代码或私有路径。通过新Run当前权限/代际与独立执行审批，在GUI主线程仅调用一次原生doc.undo，核对原before值和Undo/Redo历史迁移；不重算、保存、redo或关闭文档，不能保证任意原生回调的原子回滚。外部GUI不继承Task OS沙箱；有待提交事务/编辑态或外部引用方时拒绝。partial/unknown/停止后查同一operationId，不重复撤销或自动redo。",
      schema: cadGuiUndoOperationInputSchema,
      approvalReviewKind: "cad-gui-undo",
      execute: (input, context) => service.guiUndoOperation(input, context),
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
        "在 Task 沙箱中打开独立 FCStd 工程，重算并检查对象类型、状态、Shape 有效性、实体数、体积、包围盒与 Body.Tip。可选 edges={objectName,offset,limit} 按页读取指定对象当前真实 EdgeN，默认50条，沿 edgePage.nextOffset 可继续取完；返回全局毫米坐标、曲线类型、长度、原生顶点、边界与闭合状态。退化边的曲线和边界为null，闭合圆可以只有一个顶点。几何改变后重新读取边编号。源文件不保存；工程恢复会执行 FreeCAD，因此仍按执行权限审批。",
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
        "在独立 FreeCAD 工程按顺序创建 Body、矩形/圆约束草图、首个 Pad、Pocket、首个 Revolution、Body 布尔、显式边圆角/等距倒角或修改尺寸；长度单位 mm，角度单位 deg。轮廓名在同一草图内唯一；origin 为矩形左下角、center 为圆心，均为固定绝对坐标，不自动随其它轮廓改尺寸居中。草图完全约束，驱动尺寸命名为轮廓名_Width/_Height/_Radius。结构化 Pad 限同 Body 首个正向 XY 定长单侧特征；孔草图同时指定 body/supportPad，将局部 Z 以固定表达式绑定该 Pad.Length。Pocket 使用当前 Body.Tip 的该 Pad 为基体，profile 必须是与其绑定且尚未被特征消费的孔草图；mode=depth 必填 depth，through_all 不带 depth。Revolution 限同 Body 首个自由 XY 草图绕本草图局部轴正向单侧旋转，axis=x/y，angle取值(0,360]；不使用任意外部轴。create_boolean 指定 body、非空且唯一的 toolBodies 以及 operation=fuse/cut/common；目标与工具均须有有效单实体 Tip，不接受目标自身或已被其它 Boolean 使用的工具 Body；创建真实参数化特征，保留 BaseFeature/Group/Tip，后续可修改上游尺寸重算。无交集 cut 可保留原体，空结果或多实体结果拒绝发布。多工具 common 沿 FreeCAD 原生语义；需要依次求交时按序创建多个单工具 common，不把工具组静默解释成逐次交集。create_fillet/create_chamfer 指定 body、当前 Tip 的 base、真实且唯一的 edges，分别给正数 radius/size；只做定半径圆角/等距倒角，每条边均须被原生接纳，混入平滑边整批拒绝。后台修饰工程使用 FreeCAD 官方完整拓扑名（UseHasher=false），保留TNP及参数链；切换会原生重算工作副本，选边几何变化或任意依赖失效均拒绝发布。create_linear_pattern/create_polar_pattern 指定 body、支撑历史中的单个 original（Pad/Pocket/Revolution）和同 Body 上游草图轴；direction/axis 为 {sketch,axis:H_Axis/V_Axis/N_Axis}。线性 length 是首末总距离，环形 angle 是正向总角度(0,360]，occurrences 包含原件且允许1，reversed 反转方向。当前 Tip 作为支撑，较早原件可单独重复；抑制原件拒绝。尊重 Body.AllowCompound，允许多实体时必须保留全部结果，单实体工程不能截断副本。set_pattern_parameters 用 object 加 length/angle/occurrences/reversed 批改，一次重算；固定 Features/Extent 单方向，拒绝改其它模式。直接改表达式目标拒绝，未指定的表达式字段可联动并保留绑定。完整增减材副本布尔结果须与实际结果一致，保持后继Tip/引用/显隐。set_dimension 的 width/height 及草图 radius 必须带 profile，仅修改唯一且类型匹配的命名驱动尺寸；不带 profile 的 radius 仅改 Fillet.Radius，size 仅改显式选边等距 Chamfer.Size；length 只改固定长度 Pad、depth 只改有限 Pocket，angle 只改固定角 Revolution；length/depth/angle 均不带 profile。拒绝已有表达式、参考或停用尺寸，不解除绑定。修改尺寸保持当前 Tip 和可见性。documentPath只读源工程，outputPath必须是新FCStd；不接管当前GUI文档。data.operations返回实际状态和尺寸；失败不发布最终文件，不承诺中间副作用事务回滚。更广建模形态用cad_run_python，沿用Task权限和审批。",
      schema: cadOperationsInputSchema,
      approvalReviewKind: "cad-operations",
      execute: (input, context) =>
        service.execute({ action: "operations", input }, context),
    }),
    definition({
      name: "cad_export",
      description:
        "重算并验证 FreeCAD 工程后导出新 STEP/STL/OBJ/BREP 或2D SVG/DXF 文件，不覆盖已有文件。可用 objectNames 显式指定几何对象；默认使用依赖图末端几何。SVG/DXF按view投影（默认top）；PartDesign先检查Body.Tip，其它工程核对实际目标对象，避免导出被替代的历史形状。SVG的高阶或有理曲线可能使用折线近似，精度要求查看preview.svgEncoding中的近似记录；可编辑原曲线仍在FCStd。",
      schema: cadExportInputSchema,
      approvalReviewKind: "cad-export",
      execute: (input, context) =>
        service.execute({ action: "export", input }, context),
    }),
    definition({
      name: "cad_preview",
      description:
        "基于 FreeCAD TechDraw 的真实几何投影生成线框 PNG 预览与 SVG，返回模型可观察的图片并保留 Task 文件。不依赖 Blender 或 GUI，不是着色渲染。view 可为isometric/top/front/right（默认isometric），objectNames可显式选几何；outputPath必须是新PNG文件。PartDesign先核对Body.Tip，其它工程核对实际目标对象。",
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
