import { z } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import type { ApprovalReviewKind } from "../permissions/approval-review-context.js";
import type { CadService, CadToolResult } from "./service.js";
import {
  cadDescribeInputSchema,
  cadExportInputSchema,
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
  return [
    definition({
      name: "cad_status",
      description:
        "检查官方 CAD 插件和已安装 FreeCAD 后台运行时。先查询状态；发现可执行文件不代表所有工作台已通过验收。不会操作当前打开的 FreeCAD 文档。",
      schema: cadStatusSchema,
      execute: (_input, context) => service.status(context),
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
        "在 Task 的真实 OS 沙箱中执行完整 FreeCAD Python source（按当前权限审批），覆盖草图约束、PartDesign、布尔、阵列、TechDraw 和其它已安装 Python 模块。预置 App/FreeCAD、Part、doc、output_directory，可 import 其它模块。documentPath仅读已有工程，新建省略；outputPath必须是新文件，由工具最终发布。中间重开验证用output_directory暂存，最终doc交给工具保存。可选result普通JSON原样放回执data，不自动去敏；stdout私有，大结果/媒体写Task文件返回路径。3D任务设置requireSolids:true，显式body.Tip=最终特征并检查尺寸/体积；2D检查Sketch自身几何，纯草图Body可无Tip/空Shape。无效几何或重算失败不报告成功。任意Python效果受Task权限约束。后台无Gui视图，用cad_preview检查线框。",
      schema: cadPythonInputSchema,
      approvalReviewKind: "cad-python",
      execute: (input, context) =>
        service.execute({ action: "python", input }, context),
    }),
  ];
}
