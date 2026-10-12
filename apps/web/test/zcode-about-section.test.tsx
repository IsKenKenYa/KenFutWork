// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlatformProvider } from "@zui/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { afterEach, describe, expect, it, vi } from "vitest";
// web 工程没有 @zcode/shared 路径映射（运行时经 cuaSharedAdapter 别名），类型直接取构建产物
import type { IPlatformService } from "../../../packages/zcode-shared/dist/index.js";
import { DesktopCommandIds } from "../../../packages/zcode-shared/dist/index.js";
import { HostAboutSection } from "../src/components/workbench/zcode/host/AboutSection";

/**
 * ZCode 设置 → 关于（宿主件，T16）。
 *
 * 锁三件事：
 * 1. 信息面板与旧版独立关于页同一契约（产品名 + 服务端身份 + 地址 + 许可 + 法律文档），
 *    版本号只随「服务端」行出现一次；
 * 2. 「检查更新」按钮走 vendored 桌面更新缝（useDesktopUpdateMenu →
 *    executeDesktopCommand(CheckForUpdates)）；非桌面形态按能力如实隐藏；
 * 3. 服务端读不到时如实「未连接」，不编版本。
 *
 * 桌面接线用例显式放开 vendored 的 Preview 身份门禁（shouldShowDesktopUpdateEntry），
 * 只验证按钮到 executeDesktopCommand 的接线本身。
 */
vi.mock("@zui/lib/desktopUpdateMenu.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  shouldShowDesktopUpdateEntry: () => true,
}));

const executeDesktopCommand = vi.fn();

function stubHealth(payload: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ok
        ? new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("", { status: 500 }),
    ),
  );
}

function renderAbout({ isDesktop = false }: { isDesktop?: boolean } = {}) {
  const platform = {
    executeDesktopCommand,
    onUpdateStateChanged: () => () => {},
    getUpdateState: async () => ({ kind: "idle", enabled: true }),
  } as unknown as IPlatformService;
  return render(
    <PlatformProvider platform={platform}>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <HostAboutSection isDesktop={isDesktop} />
      </ZCodeIntlProvider>
    </PlatformProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ZCode 设置 → 关于（宿主件）", () => {
  it("信息面板：产品名 + 服务端 + 地址（许可与隐私承诺也在）", async () => {
    stubHealth({ ok: true, service: "kenfutwork-server", version: "1.2.3" });
    const { container } = renderAbout();

    expect(screen.getByText("KenFutWork")).toBeVisible();
    expect(screen.getByText("BYOK 的 AI 工作台")).toBeVisible();
    expect(await screen.findByText("kenfutwork-server · v1.2.3")).toBeVisible();
    // 地址 = surfaceApi 兜底口径（未注入 apiBase 时是页面 origin）
    expect(screen.getByText(window.location.origin)).toBeVisible();
    expect(screen.getByText("录音不留存")).toBeVisible();
    for (const label of ["最终用户许可协议", "隐私政策", "第三方声明"]) {
      expect(screen.getByText(label)).toBeVisible();
    }
    // 版本号只出现一次：产品名后面不许再标版本
    expect(container.textContent?.match(/v1\.2\.3/g)).toHaveLength(1);
  });

  it("服务端读不到时如实说「未连接」，不编造版本", async () => {
    stubHealth(null, false);
    const { container } = renderAbout();
    expect(await screen.findByText("未连接")).toBeVisible();
    expect(container.textContent).not.toMatch(/v\d+\.\d+\.\d+/);
  });

  it("Web 形态不出现「检查更新」（按平台能力如实隐藏）", async () => {
    stubHealth({ ok: true, service: "kenfutwork-server", version: "1.2.3" });
    renderAbout({ isDesktop: false });
    await screen.findByText("kenfutwork-server · v1.2.3");
    expect(screen.queryByRole("button", { name: /更新/ })).toBeNull();
  });

  it("桌面形态显示「检查更新」，点击走 executeDesktopCommand(CheckForUpdates)", async () => {
    stubHealth({ ok: true, service: "kenfutwork-server", version: "1.2.3" });
    renderAbout({ isDesktop: true });

    const button = await screen.findByRole("button", { name: "检查更新" });
    const user = userEvent.setup();
    await user.click(button);

    expect(executeDesktopCommand).toHaveBeenCalledWith(
      DesktopCommandIds.CheckForUpdates,
    );
  });
});
