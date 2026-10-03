import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { Root } from "@zui/root";
import { useAlertDialogStore } from "@zui/store/alertDialogStore";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { createCodeRootHostFetch } from "./setup/code-root-host-http";

const clients: CodeHttpChannelClient[] = [];
const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollTo",
);
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.dispose();
  vi.unstubAllGlobals();
  localStorage.clear();
  if (scrollToDescriptor)
    Object.defineProperty(Element.prototype, "scrollTo", scrollToDescriptor);
  else Reflect.deleteProperty(Element.prototype, "scrollTo");
});

function installBrowserLayout() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }));
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    value() {},
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

it.each([true, false])(
  "无ZCode云服务的原Root显示工作台、目录选择及全局应答（指定目录：%s）",
  async (hasInitialDirectory) => {
    const calls: Array<{ service: string; method: string; args: unknown[] }> =
      [];
    const selection = { rejectOpen: true };
    installBrowserLayout();
    vi.stubGlobal("fetch", createCodeRootHostFetch(calls, selection));
    const client = new CodeHttpChannelClient({
      apiBase: "https://host.example",
    });
    clients.push(client);
    await client.connect();
    const platform = createCodePlatform(client);
    render(
      <ZCodeIntlProvider initialLocale="zh-CN">
        <Root
          services={client.services}
          platform={platform}
          {...(hasInitialDirectory ? { initialWorkspaceAbsPath: "/code" } : {})}
          restoreSession={false}
          allowRemoteWorkspace={false}
          preferDirectoryBrowser
          initialWorkspaceLoadingFallback={<span>原入口加载</span>}
        />
      </ZCodeIntlProvider>,
    );
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.service === "modelSelectionService" &&
            call.method === "getView",
        ),
      ).toBe(true),
    );
    expect(
      calls.filter((call) =>
        [
          "oauth",
          "credential",
          "coding-plan-subscription",
          "onboarding-record",
          "bots",
        ].includes(call.service),
      ),
    ).toEqual([]);
    expect(await screen.findByRole("textbox")).not.toBeNull();
    expect(
      calls.some(
        (call) =>
          call.service === "file" &&
          call.method === "ensureConversationWorkspace",
      ),
    ).toBe(!hasInitialDirectory);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(await screen.findByText("显示隐藏目录")).not.toBeNull();
    const select = await screen.findByRole("button", { name: "选择此目录" });
    await waitFor(() => expect(select.hasAttribute("disabled")).toBe(false));
    fireEvent.click(select);
    expect(
      (await screen.findAllByText(/目录项目已归档/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("显示隐藏目录")).not.toBeNull();
    selection.rejectOpen = false;
    fireEvent.click(screen.getByRole("button", { name: "选择此目录" }));
    await waitFor(() => expect(screen.queryByText("显示隐藏目录")).toBeNull());
    expect(
      calls
        .filter(
          (call) => call.service === "workspace" && call.method === "open",
        )
        .map((call) => call.args),
    ).toEqual([[{ path: "/code" }], [{ path: "/code" }]]);
    const alert = useAlertDialogStore.getState().requestAlert({
      title: "原全局提示",
      description: "真实宿主操作提示",
      actionLabel: "确认提示",
    });
    await act(async () => {
      await Promise.resolve();
    });
    const confirm = await screen.findByRole("button", { name: /确认提示/ });
    fireEvent.click(confirm);
    await expect(alert).resolves.toBe(true);
  },
);
