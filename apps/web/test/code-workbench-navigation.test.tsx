import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { Root } from "@zui/Root";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { createHostWorkbenchNavigation } from "../src/components/workbench/zcode/host/workbenchNavigation";
import { bindCodeWorkspaceServices } from "../src/components/workbench/zcode/host/workspaceServices";
import {
  installCodeRootBrowser,
  restoreCodeRootBrowser,
} from "./setup/code-root-host-browser";
import {
  createCodeRootHostFetch,
  rootProjectId,
  rootWorkspace,
} from "./setup/code-root-host-http";

let client: CodeHttpChannelClient | undefined,
  release: (() => void) | undefined,
  disposeNavigation: (() => void) | undefined;
afterEach(() => {
  cleanup();
  disposeNavigation?.();
  release?.();
  client?.dispose();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.replaceChildren();
  restoreCodeRootBrowser();
});

it("原Code侧栏使用横排模式按钮，可信宿主能力才显示Flow；导航保持coding且旧菜单不重复", async () => {
  installCodeRootBrowser();
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  vi.stubGlobal("fetch", createCodeRootHostFetch(calls, { rejectOpen: false }));
  const parentFrame = document.createElement("iframe");
  document.body.append(parentFrame);
  const parent = parentFrame.contentWindow;
  if (!parent) throw new Error("父窗口未创建");
  const post = vi.spyOn(parent, "postMessage");
  const navigation = createHostWorkbenchNavigation(parent, ["code", "design"]);
  disposeNavigation = navigation.dispose;
  const host = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  client = host;
  await host.connect();
  host.registerWorkspaces([rootWorkspace]);
  release = bindCodeWorkspaceServices(host);
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <Root
        services={host.services}
        platform={createCodePlatform(host, { workbenchNavigation: navigation })}
        initialWorkspaceAbsPath="/code"
        initialWorkspaceIdentity={JSON.stringify([rootProjectId, "/code"])}
        restoreSession={false}
        allowRemoteWorkspace={false}
        onInterfaceModeChange={() => {}}
      />
    </ZCodeIntlProvider>,
  );
  const code = await screen.findByRole("radio", { name: "Code" });
  expect(code.getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("radio", { name: "Flow" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Design" }));
  expect(post).toHaveBeenCalledWith(
    { type: "kenfutwork:code-navigate", mode: "design" },
    window.location.origin,
  );
  expect(code.getAttribute("aria-checked")).toBe("true");
  const update = {
    type: "kenfutwork:workbench-navigation",
    availableModes: ["code", "design", "flow"],
  };
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: window,
      data: update,
    }),
  );
  expect(screen.queryByRole("radio", { name: "Flow" })).toBeNull();
  await act(async () =>
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source: parent,
        data: update,
      }),
    ),
  );
  fireEvent.click(await screen.findByRole("radio", { name: "Flow" }));
  expect(post).toHaveBeenLastCalledWith(
    { type: "kenfutwork:code-navigate", mode: "flow" },
    window.location.origin,
  );
  fireEvent.click(screen.getByRole("button", { name: "连接使用" }));
  expect(screen.queryByText("界面模式")).toBeNull();
});
