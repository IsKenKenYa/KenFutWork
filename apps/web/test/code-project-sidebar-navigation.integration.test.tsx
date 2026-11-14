// @vitest-environment node
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installCodePublicHostDom } from "./setup/code-public-host-dom.js";
import { withProjectionResources } from "./setup/code-task-project-projection.fixture.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原项目导航的入口状态",
  () => {
    it("禁用新建入口期间不接收点击，恢复后可以创建新草稿", async () => {
      await withProjectionResources(async ({ client }, resources) => {
        resources.releaseDom = await installCodePublicHostDom();
        const [
          { ServiceProvider },
          { PlatformProvider },
          { ZCodeIntlProvider },
          { createCodePlatform },
          { ProjectSidebarNavigation },
        ] = await Promise.all([
          import("@zui/hooks/useServices.js"),
          import("@zui/hooks/usePlatform.js"),
          import("@zui/i18n/IntlProvider.js"),
          import("../src/components/workbench/zcode/host/platform.js"),
          import("@zui/project-sidebar/ProjectSidebarNavigation.js"),
        ]);
        const platform = createCodePlatform(client);
        let drafts = 0;
        const surface = (disabled: boolean) => (
          <ServiceProvider services={client.services}>
            <PlatformProvider platform={platform}>
              <ZCodeIntlProvider initialLocale="zh-CN">
                <ProjectSidebarNavigation
                  props={{}}
                  disabled={disabled}
                  onCreate={() => {
                    drafts++;
                  }}
                />
              </ZCodeIntlProvider>
            </PlatformProvider>
          </ServiceProvider>
        );
        const view = render(surface(true));
        resources.unmount = () => view.unmount();
        const button = view.getByTestId("task-new-button");
        expect(button.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(button);
        expect(drafts).toBe(0);
        view.rerender(surface(false));
        expect(button.getAttribute("aria-disabled")).toBe("false");
        fireEvent.click(button);
        expect(drafts).toBe(1);
        view.rerender(surface(true));
        expect(button.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(button);
        expect(drafts).toBe(1);
      });
    }, 90_000); // 真实服务准备、原导航DOM及关闭期限。
  },
);
