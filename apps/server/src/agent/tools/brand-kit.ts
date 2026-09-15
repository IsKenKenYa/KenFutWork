import type { BrandKitDetail } from "@kenfutwork/shared";
import { tool } from "langchain";
import { z } from "zod";
import type { AuthenticatedUser } from "../../features/auth/types.js";
import type { BrandKitService } from "../../features/brand-kit/brand-kit-service.js";

const brandKitSchema = z.object({});

/**
 * `get_brand_kit` 工具：复用 brand-kit 服务读取套件（含签名 URL 解析），
 * 不再自持 Supabase 客户端。
 *
 * 身份从运行上下文取：`access_token` + `user_id` 由 runtime 注入到
 * `configurable`（`user_id` 是服务侧 `:user` 隔离谓词所需的身份）。
 */
export function createBrandKitTool(
  deps: { brandKitService: BrandKitService },
  brandKitId: string,
) {
  return tool(
    async (_input, config) => {
      const configurable = (
        config as { configurable?: Record<string, unknown> }
      )?.configurable;
      const accessToken = configurable?.access_token;
      const userId = configurable?.user_id;

      if (typeof accessToken !== "string" || typeof userId !== "string") {
        return JSON.stringify({
          error: "Missing access token or user id in run context",
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
    {
      name: "get_brand_kit",
      description:
        "查询当前项目绑定的品牌套件信息，包含设计指南、颜色、字体、Logo等品牌资产。当用户提到品牌、风格、设计规范时使用此工具。",
      schema: brandKitSchema,
    },
  );
}
