// @vitest-environment node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceChannels } from "../../../packages/zcode-shared/dist/channels.js";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import {
  type OriginalSessionView,
  type PublicFixture,
  renderOriginalSession,
} from "./setup/code-public-session";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** JSDOM不排版；只补浏览器字体/视口尺寸，原xterm与renderer保持实际实现。 */
function prepareTerminalBrowser() {
  vi.stubGlobal("self", window);
  window.matchMedia = matchMedia;
  for (const [property, size] of [
    ["offsetWidth", 800],
    ["clientWidth", 800],
    ["offsetHeight", 400],
    ["clientHeight", 400],
  ] as const) {
    vi.spyOn(HTMLElement.prototype, property, "get").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("xterm-char-measure-element"))
          return property.endsWith("Width") ? 256 : 16;
        return size;
      },
    );
  }
}

describe.skipIf(
  process.env.RUN_CODE_UI_INTEGRATION !== "1" || process.platform !== "darwin",
)("原TerminalSession真实PTY公开接线 integration", () => {
  it("原组件绑定Task并呈现真实输出，卸载重挂保留同一PTY和脱离期间输出，原退出回调等待真实退出", async () => {
    const httpLoading: Promise<{
      createCodeUiHttpFixture(): Promise<PublicFixture>;
    }> = import(fixturePath);
    const [http, sessions, streams] = await Promise.all([
      httpLoading,
      import("../../server/src/features/code-ui/host-session.fixture.js"),
      import("../../server/src/features/code-ui/model-stream.fixture.js"),
    ]);
    const fixture = await http.createCodeUiHttpFixture();
    const model = await streams.heldModel();
    let host: Host | undefined;
    let session: OriginalSessionView | undefined;
    let terminalView: ReturnType<typeof render> | undefined;
    let releaseTerminal: (() => void) | undefined;
    try {
      host = await sessions.createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      expect(
        (
          await fixture.client.request(
            "/api/instance/settings",
            { terminalShell: "sh" },
            "PATCH",
          )
        ).status,
      ).toBe(200);
      session = await renderOriginalSession(
        fixture,
        host,
        prepareTerminalBrowser,
      );
      releaseDom = session.releaseDom;
      const [component, registry, providers] = await Promise.all([
        import("@zui/terminal/TerminalSession"),
        import("@zui/terminal/sidePaneTerminalSessionRegistry"),
        import("./setup/code-public-host-ui"),
      ]);
      const Providers = await providers.loadCodePublicHostProviders();
      const key = `original-pty-${host.sessionId}`;
      releaseTerminal = () =>
        registry.sidePaneTerminalSessionRegistry.release(key);
      const created: Array<{ id: string; taskId: string }> = [];
      const fetchOriginal = globalThis.fetch;
      // 只观察外部HTTP，原终端服务、连接桥、Task作用域与PTY均不替换。
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const response = await fetchOriginal(input, init);
        if (typeof init?.body === "string") {
          const request = JSON.parse(init.body);
          if (
            request.service === ServiceChannels.Terminal &&
            request.method === "create" &&
            response.ok
          ) {
            const reply = await response.clone().json();
            created.push({
              id: reply.result.id,
              taskId: request.args[0].taskId,
            });
          }
        }
        return response;
      });
      const exits: number[] = [];
      const client = session.client;
      const terminal = (
        <Providers client={client}>
          <div style={{ width: 800, height: 400 }}>
            <component.TerminalSession
              sessionId={key}
              persistentKey={key}
              workspaceKey={JSON.stringify([
                host.projectId,
                host.workspacePath,
              ])}
              cwd={host.workspacePath}
              services={client.services}
              isVisible
              onShellLabelChange={() => {}}
              onExit={(_session, code) => exits.push(code)}
              onOpenBrowserUrl={() => {
                throw new Error("本回归没有请求打开浏览器");
              }}
            />
          </div>
        </Providers>
      );
      terminalView = render(terminal);
      const activeView = terminalView;
      await vi.waitFor(() => expect(created).toHaveLength(1), {
        timeout: 30_000,
      });
      expect(created[0]?.taskId).toBe(host.sessionId);
      const id = created[0]?.id;
      if (!id) throw new Error("原组件未取得真实PTY身份");
      const textarea = activeView.container.querySelector(
        "textarea.xterm-helper-textarea",
      );
      if (!textarea) throw new Error("原终端输入控件缺失");
      fireEvent.paste(textarea, {
        clipboardData: {
          getData: () =>
            "printf '\\124\\105\\122\\115\\111\\116\\101\\114\\137\\120\\125\\102\\114\\111\\103\\n' > original-pty.txt; cat original-pty.txt\r",
        },
      });
      const path = join(host.workspacePath, "original-pty.txt");
      await vi.waitFor(
        async () =>
          expect(await readFile(path, "utf8")).toBe("TERMINAL_PUBLIC\n"),
        { timeout: 30_000 },
      );
      await vi.waitFor(
        () =>
          expect(activeView.container.textContent).toContain("TERMINAL_PUBLIC"),
        { timeout: 30_000 },
      );
      terminalView.rerender(null);
      await client.services.terminalService.write({
        id,
        data: "printf '\\104\\105\\124\\101\\103\\110\\105\\104\\137\\117\\125\\124\\120\\125\\124\\n'\r",
      });
      terminalView.rerender(terminal);
      await vi.waitFor(
        () =>
          expect(activeView.container.textContent).toContain("DETACHED_OUTPUT"),
        { timeout: 30_000 },
      );
      expect(terminalView.container.textContent).toContain("TERMINAL_PUBLIC");
      expect(created).toEqual([{ id, taskId: host.sessionId }]);
      fireEvent.paste(textarea, { clipboardData: { getData: () => "exit\r" } });
      await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 30_000 });
      expect(model.requests).toHaveLength(0);
      releaseTerminal();
      releaseTerminal = undefined;
      session.dispose();
      // 外部await仍收到真实取消；只为原void销毁回调补观察，不将拒绝改成成功。
      await expect(
        client.services.terminalService.dispose({ id }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      releaseTerminal?.();
      terminalView?.unmount();
      session?.dispose();
      if (host) await host.dispose();
      await model.close();
      await fixture.close();
    }
  }, 120_000);
});
