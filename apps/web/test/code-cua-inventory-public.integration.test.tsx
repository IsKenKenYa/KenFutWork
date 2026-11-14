// @vitest-environment node
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { installCodePublicHostDom } from "./setup/code-public-host-dom";
import { loadCodePublicHostProviders } from "./setup/code-public-host-ui";
import type { PublicFixture } from "./setup/code-public-session";

const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);
let releaseDom: (() => void) | undefined;
afterEach(() => {
  cleanup();
  releaseDom?.();
  releaseDom = undefined;
  vi.unstubAllGlobals();
});

async function withInstalledComputerUse(
  check: (context: {
    client: CodeHttpChannelClient;
    pluginId: string;
    target: { workspacePath: string; workspaceIdentity: string };
    view: ReturnType<typeof render>;
  }) => Promise<void>,
  options: { withoutWorkspace?: boolean } = {},
) {
  const fixtureLoading: Promise<{
    createCodeUiHttpFixture(options: {
      builtinPluginsDir: string;
      allowThirdPartyPlugins: boolean;
    }): Promise<PublicFixture & { directory: string }>;
  }> = import(fixturePath);
  const http = await fixtureLoading;
  const fixture = await http.createCodeUiHttpFixture({
    builtinPluginsDir: fileURLToPath(
      new URL("../../../plugins/", import.meta.url),
    ),
    allowThirdPartyPlugins: false,
  });
  let disposeClient: (() => void) | undefined;
  try {
    const projectDirectory = join(fixture.directory, "cua-project");
    await mkdir(projectDirectory);
    const stream = await fixture.client.openCodeStream();
    const opened = await fixture.client.request("/api/code-ui/rpc", {
      connectionId: stream.ready.hello.connectionId,
      service: "workspace",
      method: "open",
      args: [{ path: projectDirectory }],
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    releaseDom = await installCodePublicHostDom();
    const [channel, computerUse, Providers] = await Promise.all([
      import("../src/components/workbench/zcode/host/httpChannelClient"),
      import("@zui-original/settings/ComputerUseSection"),
      loadCodePublicHostProviders(),
    ]);
    const client = new channel.CodeHttpChannelClient({
      apiBase: fixture.baseUrl,
      accessToken: await fixture.app.kernel
        .get("localAccess")
        .getDesktopToken(),
    });
    disposeClient = () => client.dispose();
    await client.connect();
    const project = await client.openWorkspace(
      projectDirectory,
      opened.body.result.projectId,
    );
    const workspaceIdentity = JSON.stringify([
      project.projectId,
      projectDirectory,
    ]);
    const target = { workspacePath: projectDirectory, workspaceIdentity };
    const installed =
      await client.services.pluginManagementService.installPlugin({
        ...target,
        pluginName: "kenfutwork-computer-use",
        marketplace: "kenfutwork-bundled",
      });
    const plugin = installed.installedPlugins.find(
      (entry) => entry.name === "kenfutwork-computer-use",
    );
    if (!plugin) throw new Error("真实安装结果缺少 Computer Use 插件");
    await client.services.pluginManagementService.setPluginEnabled({
      ...target,
      pluginId: plugin.id,
      enabled: true,
    });

    // Windows 分支只读取插件状态，不查询 Helper 或更改任何系统权限。
    const view = render(
      <Providers client={client}>
        <computerUse.ComputerUseSection
          isDesktop
          isWindowsDesktop
          {...(options.withoutWorkspace
            ? {}
            : { workspacePath: projectDirectory, workspaceIdentity })}
        />
      </Providers>,
    );
    await check({ client, pluginId: plugin.id, target, view });
  } finally {
    cleanup();
    disposeClient?.();
    await fixture.close();
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Computer Use 原设置与真实插件库存 integration",
  () => {
    it("自带 Computer Use 已真实安装并启用时原设置开关显示开启", async () => {
      await withInstalledComputerUse(async ({ view }) => {
        await waitFor(() =>
          expect(
            view
              .getByRole("switch", { name: "启用电脑控制" })
              .getAttribute("aria-checked"),
          ).toBe("true"),
        );
      });
    }, 90_000);

    it("无激活工作区时仍按本机实例库存显示插件开启", async () => {
      await withInstalledComputerUse(
        async ({ view }) => {
          await waitFor(() =>
            expect(
              view
                .getByRole("switch", { name: "启用电脑控制" })
                .getAttribute("aria-checked"),
            ).toBe("true"),
          );
        },
        { withoutWorkspace: true },
      );
    }, 90_000);

    it("原设置关闭电脑控制后真实自带插件库存保持停用", async () => {
      await withInstalledComputerUse(async (context) => {
        const { client, pluginId, target, view } = context;
        const toggle = view.getByRole("switch", { name: "启用电脑控制" });
        await waitFor(() =>
          expect(toggle.getAttribute("aria-checked")).toBe("true"),
        );

        fireEvent.click(toggle);

        await waitFor(async () => {
          const inventory =
            await client.services.pluginManagementService.getPluginsOverview(
              target,
            );
          expect(
            inventory.installedPlugins.find((plugin) => plugin.id === pluginId)
              ?.enabled,
          ).toBe(false);
        });

        await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        fireEvent.click(toggle);

        await waitFor(async () => {
          const inventory =
            await client.services.pluginManagementService.getPluginsOverview(
              target,
            );
          expect(
            inventory.installedPlugins.find((plugin) => plugin.id === pluginId)
              ?.enabled,
          ).toBe(true);
        });
        await waitFor(() =>
          expect(toggle.getAttribute("aria-checked")).toBe("true"),
        );
      });
    }, 90_000);
  },
);
