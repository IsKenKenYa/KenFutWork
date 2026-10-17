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
        "在 Task 的真实 OS 沙箱中执行完整 FreeCAD Python source（按当前权限审批），覆盖草图约束、PartDesign、布尔、阵列、TechDraw 和其它已安装 Python 模块。预置 App/FreeCAD、Part、doc、output_directory，可 import 其它模块。可选设置 result 为普通 JSON 值，原样放入回执data（不自动去敏）；stdout仍为私有日志。大结果/媒体写Task文件再返回路径，完整回执受当前进程输出设置约束。末尾保留有效 doc；显式设 body.Tip=最终特征并检查预期尺寸/体积。重算失败或无效几何不会报告成功；输出为新 FCStd。requireSolids 可要求实体，expectedVolume 做数值验收。任意Python与文件/网络效果都受当前Task权限约束，不是纯建模命令。后台不可使用Gui视图；用cad_preview生成真实几何线框预览。",
      schema: cadPythonInputSchema,
      approvalReviewKind: "cad-python",
      execute: (input, context) =>
        service.execute({ action: "python", input }, context),
    }),
  ];
}
