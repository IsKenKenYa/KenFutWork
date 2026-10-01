import type { BrandKitDetail } from "@kenfutwork/shared";
import { z } from "zod";

import type { AuthenticatedUser } from "../../features/auth/types.js";
import type { BrandKitService } from "../../features/brand-kit/brand-kit-service.js";
import type { CanvasRepository } from "../../features/canvas/repository.js";
import type { ToolDefinition } from "../../kernel/types.js";

const brandKitSchema = z.object({});

/**
 * `get_brand_kit`（design preset）：复用 brand-kit 服务读取套件（含签名 URL
 * 解析），经内核工具注册表（`ctx.tools`）贡献。
 *
 * 身份与套件绑定都在 execute 期从 `execCtx` 解析：`accessToken`/`userId`
 * 构造服务侧 `:user` 隔离谓词；`brandKitId` 由画布 → 项目单条 JOIN 重推导
 * （与 runtime 起始期解析同一口径），绑定不存在时如实告知。
 */
export function createBrandKitToolDefinition(deps: {
  brandKitService: BrandKitService;
  canvasRepository?: CanvasRepository;
}): ToolDefinition {
  return {
    name: "get_brand_kit",
    description:
      "查询当前项目绑定的品牌套件信息，包含设计指南、颜色、字体、Logo等品牌资产。当用户提到品牌、风格、设计规范时使用此工具。",
    scope: "design",
    zodSchema: brandKitSchema,
    parameters: z.toJSONSchema(brandKitSchema),
    execute: async (_args, execCtx) => {
      const accessToken = execCtx.accessToken;
      const userId = execCtx.userId;

      if (typeof accessToken !== "string" || typeof userId !== "string") {
        return JSON.stringify({
          error: "Missing access token or user id in run context",
        });
      }

      // 画布 → 项目 → 绑定的品牌套件（单条 JOIN，工作区作用域）
      const brandKitId =
        execCtx.canvasId && execCtx.workspaceId && deps.canvasRepository
          ? await deps.canvasRepository
              .findProjectBrandKitId(execCtx.workspaceId, execCtx.canvasId)
              .catch(() => null)
          : null;

      if (!brandKitId) {
        return JSON.stringify({
          error: "no_brand_kit_bound",
          message: "当前画布对应的项目未绑定品牌套件。",
        });
      }

      const user: AuthenticatedUser = {
        accessToken,
        email: "",
        id: userId,
        userMetadata: {},
      };

      let kit: BrandKitDetail;
      try {
        kit = await deps.brandKitService.getKit(user, brandKitId);
      } catch {
        return JSON.stringify({ error: "Brand kit not found" });
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
            name: a.display_name,
            url: a.file_url,
            role: a.role,
          })),
        images: assets
          .filter((a) => a.asset_type === "image")
          .map((a) => ({
            name: a.display_name,
            url: a.file_url,
          })),
      };

      return JSON.stringify(result, null, 2);
    },
  };
}
