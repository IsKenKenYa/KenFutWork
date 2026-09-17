import type { BrandKitDetail } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";

import type { BrandKitService } from "../../features/brand-kit/brand-kit-service.js";
import { createBrandKitTool } from "./brand-kit.js";

const KIT_ID = "kit-1";
const USER_ID = "user-1";

function kitDetail(): BrandKitDetail {
  return {
    id: KIT_ID,
    name: "品牌 A",
    is_default: false,
    guidance_text: "简洁、留白",
    cover_url: null,
    created_at: "2026-09-13T00:00:00+00:00",
    updated_at: "2026-09-13T00:00:00+00:00",
    assets: [
      {
        id: "a1",
        asset_type: "color",
        display_name: "主色",
        role: "primary",
        sort_order: 0,
        text_content: "#123456",
        file_url: null,
        metadata: {},
        created_at: "2026-09-13T00:00:00+00:00",
        updated_at: "2026-09-13T00:00:00+00:00",
      },
      {
        id: "a2",
        asset_type: "font",
        display_name: "正文",
        role: null,
        sort_order: 1,
        text_content: "Inter",
        file_url: null,
        metadata: { weight: "700" },
        created_at: "2026-09-13T00:00:00+00:00",
        updated_at: "2026-09-13T00:00:00+00:00",
      },
      {
        id: "a3",
        asset_type: "logo",
        display_name: "标志",
        role: null,
        sort_order: 2,
        text_content: null,
        file_url: "https://signed.test/logo.png",
        metadata: {},
        created_at: "2026-09-13T00:00:00+00:00",
        updated_at: "2026-09-13T00:00:00+00:00",
      },
    ],
  } as BrandKitDetail;
}

function buildTool(service: Partial<BrandKitService>) {
  return createBrandKitTool(
    { brandKitService: service as BrandKitService },
    KIT_ID,
  );
}

/** 工具从运行上下文取身份（access_token + user_id）。 */
async function invoke(
  tool: ReturnType<typeof createBrandKitTool>,
  configurable: Record<string, unknown>,
) {
  const result = await tool.invoke({}, { configurable } as never);
  return JSON.parse(result as string);
}

describe("get_brand_kit 工具（身份取自运行上下文）", () => {
  it("用 configurable 里的 access_token + user_id 调服务，并把资产按类型分组", async () => {
    const seen: Array<{ accessToken: string; userId: string; kitId: string }> =
      [];
    const tool = buildTool({
      getKit: vi.fn(async (user, kitId) => {
        seen.push({ accessToken: user.accessToken, kitId, userId: user.id });
        return kitDetail();
      }),
    });

    const output = await invoke(tool, {
      access_token: "token-1",
      user_id: USER_ID,
    });

    // 回归锁：user_id 必须从运行上下文取到并传给服务（:user 隔离谓词所需）
    expect(seen).toEqual([
      { accessToken: "token-1", kitId: KIT_ID, userId: USER_ID },
    ]);

    expect(output).toEqual({
      kit_name: "品牌 A",
      design_guidance: "简洁、留白",
      colors: [{ name: "主色", hex: "#123456", role: "primary" }],
      fonts: [{ name: "正文", family: "Inter", weight: "700", role: null }],
      logos: [
        { name: "标志", url: "https://signed.test/logo.png", role: null },
      ],
      images: [],
    });
  });

  it("字体缺 weight 时落回 400", async () => {
    const detail = kitDetail();
    const font = detail.assets[1];
    if (!font) throw new Error("测试夹具缺少第二个资产（字体）");
    detail.assets = [{ ...font, metadata: {} }] as BrandKitDetail["assets"];
    const tool = buildTool({ getKit: async () => detail });

    const output = await invoke(tool, {
      access_token: "t",
      user_id: USER_ID,
    });
    expect(output.fonts[0]?.weight).toBe("400");
  });

  it("缺 access_token 或 user_id 时明示原因，不调服务", async () => {
    const getKit = vi.fn();
    const tool = buildTool({ getKit });

    const noToken = await invoke(tool, { user_id: USER_ID });
    expect(noToken.error).toContain("access token");
    const noUser = await invoke(tool, { access_token: "t" });
    expect(noUser.error).toContain("user id");
    const neither = await invoke(tool, {});
    expect(neither.error).toContain("access token");
    expect(getKit).not.toHaveBeenCalled();
  });

  it("服务抛错（套件不存在/越权）时返回 not found，不外泄内部错误", async () => {
    const tool = buildTool({
      getKit: async () => {
        throw new Error("permission denied for table brand_kits");
      },
    });

    const output = await invoke(tool, {
      access_token: "t",
      user_id: USER_ID,
    });
    expect(output).toEqual({ error: "Brand kit not found" });
  });
});
