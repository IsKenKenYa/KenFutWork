import type { BrandKitDetail } from "@kenfutwork/shared";
import { z } from "zod";
import type { ToolDefinition } from "../../kernel/types.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import {
  type BrandKitService,
  BrandKitServiceError,
} from "./brand-kit-service.js";

const brandKitSchema = z.object({});

/**
 * `get_brand_kit`（design preset）：复用 brand-kit 服务读取套件（含签名 URL
 * 解析），经内核工具注册表（`ctx.tools`）贡献。
 *
 * 可信 Actor 提供实例隔离，套件绑定只读取接纳输入时冻结的 workContext。
 * 界面或项目默认品牌的后续切换不改变当前Run。
 */
export function createBrandKitToolDefinition(deps: {
  brandKitService: BrandKitService;
  localInstance: LocalInstanceService;
}): ToolDefinition {
  return {
    name: "get_brand_kit",
    description:
      "查询当前项目绑定的品牌套件信息，包含设计指南、颜色、字体、Logo等品牌资产。当用户提到品牌、风格、设计规范时使用此工具。",
    scope: "design",
    access: "read",
    zodSchema: brandKitSchema,
    parameters: z.toJSONSchema(brandKitSchema),
    execute: async (_args, execCtx) => {
      const actor = execCtx.actor;
      if (!actor) throw new Error("品牌工具缺少可信本地调用上下文。");
      if (
        actor.instanceId !== execCtx.instanceId ||
        (execCtx.scopeHandle &&
          execCtx.scopeHandle.describe().instanceId !== actor.instanceId)
      ) {
        throw new Error("品牌实例与可信 Task 工作域不匹配。");
      }
      await deps.localInstance.resolve(actor);

      // 套件目标来自已接纳输入，不从可变项目默认值重推。
      const brandKitId = execCtx.workContext?.brandKitId;

      if (!brandKitId) {
        return JSON.stringify({
          error: "no_brand_kit_bound",
          message: "本轮未选择品牌套件，请选择品牌后重新发送。",
        });
      }

      let kit: BrandKitDetail;
      try {
        kit = await deps.brandKitService.getKit(actor, brandKitId);
      } catch (error) {
        if (error instanceof BrandKitServiceError && error.statusCode === 404)
          return JSON.stringify({ error: "Brand kit not found" });
        throw error;
      }

      const assets = kit.assets;

      const result = {
        kit_name: kit.name,
        design_guidance: kit.guidance_text ?? "",
        colors: assets
          .filter((a) => a.asset_type === "color")
          .map((a) => ({
            name: a.display_name,
            hex: a.text_content,
            role: a.role,
          })),
        fonts: assets
          .filter((a) => a.asset_type === "font")
          .map((a) => ({
            name: a.display_name,
            family: a.text_content,
            weight: (a.metadata as { weight?: unknown })?.weight ?? "400",
            role: a.role,
          })),
        logos: assets
          .filter((a) => a.asset_type === "logo")
          .map((a) => ({
            assetId: a.id,
            ...(typeof a.metadata.mime_type === "string"
              ? { mimeType: a.metadata.mime_type }
              : {}),
            name: a.display_name,
            url: a.file_url,
            role: a.role,
          })),
        images: assets
          .filter((a) => a.asset_type === "image")
          .map((a) => ({
            assetId: a.id,
            ...(typeof a.metadata.mime_type === "string"
              ? { mimeType: a.metadata.mime_type }
              : {}),
            name: a.display_name,
            url: a.file_url,
          })),
      };

      return JSON.stringify(result, null, 2);
    },
  };
}
