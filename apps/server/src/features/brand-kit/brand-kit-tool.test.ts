import type { BrandKitDetail } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { CanvasRepository } from "../canvas/repository.js";
import type { BrandKitService } from "./brand-kit-service.js";
import { createBrandKitToolDefinition } from "./brand-kit-tool.js";

const KIT_ID = "kit-1";
const USER_ID = "user-1";
const CANVAS_ID = "canvas-1";
const WORKSPACE_ID = "ws-1";

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

function canvasRepo(
  findProjectBrandKitId: CanvasRepository["findProjectBrandKitId"],
): CanvasRepository {
  return {
    findById: async () => null,
    findProjectBrandKitId,
    findWorkspaceIdByCanvas: async () => WORKSPACE_ID,
    saveContent: async () => 1,
    appendContent: async () => 1,
  };
}

function buildTool(
  service: Partial<BrandKitService>,
  findProjectBrandKitId: CanvasRepository["findProjectBrandKitId"] = async () =>
    KIT_ID,
) {
  return createBrandKitToolDefinition({
    brandKitService: service as BrandKitService,
    canvasRepository: canvasRepo(findProjectBrandKitId),
  });
}

/** 工具从执行上下文取身份与套件绑定。 */
async function invoke(
  definition: ReturnType<typeof buildTool>,
  execCtx: ToolExecutionContext,
) {
  const result = await definition.execute({}, execCtx);
  return JSON.parse(result as string);
}

const FULL_CTX: ToolExecutionContext = {
  accessToken: "token-1",
  userId: USER_ID,
  canvasId: CANVAS_ID,
  workspaceId: WORKSPACE_ID,
};

describe("get_brand_kit 工具（身份与绑定取自执行上下文）", () => {
  it("用 execCtx 里的身份调服务、画布重推导套件绑定，并把资产按类型分组", async () => {
    const seen: Array<{ accessToken: string; userId: string; kitId: string }> =
      [];
    const tool = buildTool({
      getKit: vi.fn(async (user, kitId) => {
        seen.push({ accessToken: user.accessToken, kitId, userId: user.id });
        return kitDetail();
      }),
    });

    const output = await invoke(tool, FULL_CTX);

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

  it("画布未绑定品牌套件 → no_brand_kit_bound，不调服务", async () => {
    const getKit = vi.fn();
    const tool = buildTool({ getKit }, async () => null);

    const output = await invoke(tool, FULL_CTX);

    expect(output.error).toBe("no_brand_kit_bound");
    expect(getKit).not.toHaveBeenCalled();
  });

  it("字体缺 weight 时落回 400", async () => {
    const detail = kitDetail();
    const font = detail.assets[1];
    if (!font) throw new Error("测试夹具缺少第二个资产（字体）");
    detail.assets = [{ ...font, metadata: {} }] as BrandKitDetail["assets"];
    const tool = buildTool({ getKit: async () => detail });

    const output = await invoke(tool, FULL_CTX);
    expect(output.fonts[0]?.weight).toBe("400");
  });

  it("缺 accessToken 或 userId 时明示原因，不调服务", async () => {
    const getKit = vi.fn();
    const tool = buildTool({ getKit });

    const noToken = await invoke(tool, {
      ...FULL_CTX,
      accessToken: undefined,
    });
    expect(noToken.error).toContain("access token");
    const noUser = await invoke(tool, { ...FULL_CTX, userId: undefined });
    expect(noUser.error).toContain("user id");
    const neither = await invoke(tool, {
      canvasId: CANVAS_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(neither.error).toContain("access token");
    expect(getKit).not.toHaveBeenCalled();
  });

  it("服务抛错（套件不存在/越权）时返回 not found，不外泄内部错误", async () => {
    const tool = buildTool({
      getKit: async () => {
        throw new Error("permission denied for table brand_kits");
      },
    });

    const output = await invoke(tool, FULL_CTX);
    expect(output).toEqual({ error: "Brand kit not found" });
  });
});
