// @vitest-environment node
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import { heldModel } from "../../server/src/features/code-ui/model-stream.fixture.js";
import {
  type OriginalSessionBrowser,
  openOriginalSessionBrowser,
} from "./setup/code-public-browser.fixture.mjs";
import { clickExactText } from "./setup/code-public-browser-actions.js";
import type { PublicFixture } from "./setup/code-public-session";

const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);
const iframe = 'iframe[title="插件页面"]';

async function activate(page: OriginalSessionBrowser, label: string) {
  await vi.waitFor(
    async () => {
      const clicked = await page.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find(node =>
        node.textContent.trim() === ${JSON.stringify(label)} && node.checkVisibility());
      if (!button) return false;
      button.click();
      return true;
    })()`);
      expect(clicked).toBe(true);
    },
    { timeout: 10_000 },
  );
}

const runIntegration = process.env.RUN_CODE_UI_INTEGRATION === "1";
describe.skipIf(!runIntegration)("MCP App 原工具卡片 integration", () => {
  it("原 Task 连接交付页面与私有结果；关闭或停用后移除沙箱", async () => {
    const {
      createCodeUiHttpFixture: start,
    }: {
      createCodeUiHttpFixture(): Promise<PublicFixture & { origin: string }>;
    } = await import(fixturePath);
    const fixture = await start();
    const name = "mcp__app_probe__show_card";
    const model = await heldModel({
      toolsByRequest: {
        0: {
          id: "discover",
          name: "ToolSearch",
          arguments: { query: name, max_results: 1 },
        },
        1: { id: "open-card", name, arguments: { name: "PAGE_INPUT" } },
      },
    });
    let host: Awaited<ReturnType<typeof createCodeSessionFixture>> | undefined;
    let browser: OriginalSessionBrowser | undefined;
    try {
      host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
        initialConfig: { mode: "yolo", planEnabled: false },
        initializeGit: false,
      });
      const script = join(host.workspacePath, "app-probe.mjs");
      await copyFile(
        new URL(
          "../../server/src/features/mcp/fixtures/mcp-app-server.mjs",
          import.meta.url,
        ),
        script,
      );
      const installed = await fixture.client.request("/api/mcp/servers", {
        name: "app_probe",
        kind: "stdio",
        command: process.execPath,
        args: [script],
      });
      expect(installed.status, JSON.stringify(installed.body)).toBe(201);
      const snapshot = host.snapshot;
      const sent = await host.command("sendText", { text: "显示插件页面" });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      const result = await vi.waitFor(
        async () => {
          const current = protocol.conversationSnapshotSchema.parse(
            await snapshot(),
          );
          const row = current.rows.window.find(
            (item) => item.kind === "toolCall" && item.toolName === name,
          );
          if (
            row?.kind !== "toolCall" ||
            row.output?.display?.kind !== "mcp_tool" ||
            !row.output.display.appRef
          )
            throw new Error(JSON.stringify({ row }));
          expect(JSON.stringify(current)).not.toContain("PRIVATE_VIEW");
          return { ref: row.output.display.appRef, toolCallId: row.toolCallId };
        },
        { timeout: 35_000 },
      );
      expect(JSON.stringify(model.requests)).not.toContain("PRIVATE_VIEW");
      expect(JSON.stringify(model.requests)).not.toContain(result.ref);
      await vi.waitFor(() => expect(model.requests).toHaveLength(3));
      model.finish(2);
      await vi.waitFor(
        async () => {
          const current = protocol.conversationSnapshotSchema.parse(
            await snapshot(),
          );
          expect(current.control.phase).toBe("completedSuccess");
        },
        { timeout: 15_000 },
      );
      const wrong = await host.client.request("/api/code-ui/rpc", {
        service: "mcp-apps",
        method: "open",
        args: [{ ...result, toolCallId: "another-run/another-tool" }],
      });
      expect(wrong.status).toBe(404);
      browser = await openOriginalSessionBrowser({
        backendBaseUrl: fixture.baseUrl,
        backendOrigin: fixture.origin,
        accessToken: await fixture.app.kernel
          .get("localAccess")
          .getDesktopToken(),
        workspacePath: host.workspacePath,
        projectId: host.projectId,
        sessionId: host.sessionId,
        clientId: host.clientId,
      });
      const page = browser;
      const frameHeight = () =>
        page.evaluate(
          `document.querySelector(${JSON.stringify(iframe)})?.style.height ?? null`,
        );
      const requirePage = () =>
        vi.waitFor(
          async () => {
            const detail = await page.evaluate(
              `Array.from(document.querySelectorAll('[role="alert"]')).map(node => node.textContent)`,
            );
            expect(
              await frameHeight(),
              JSON.stringify({ detail, errors: page.pageErrors }),
            ).toBe("173px");
          },
          { timeout: 15_000 },
        );
      const requireClosed = () =>
        vi.waitFor(async () => expect(await frameHeight()).toBeNull(), {
          timeout: 10_000,
        });
      expect(await frameHeight()).toBeNull();
      const historyButton = 'button[data-history-open="false"]';
      const history = await vi.waitFor(
        async () => {
          const label = await page.evaluate<string | null>(
            `document.querySelector(${JSON.stringify(historyButton)})?.textContent?.trim() ?? null`,
          );
          if (!label) throw new Error("未见已完成的工具过程");
          return label;
        },
        { timeout: 10_000 },
      );
      await clickExactText(page, historyButton, history);
      await activate(page, "打开插件页面");
      await requirePage();
      await activate(page, "关闭插件页面");
      await requireClosed();
      await activate(page, "打开插件页面");
      await requirePage();
      const stopped = await fixture.client.request(
        `/api/mcp/servers/${installed.body.server.id}`,
        { enabled: false },
        "PATCH",
      );
      expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
      await requireClosed();
    } finally {
      await browser?.close();
      await model.close();
      await host?.dispose();
      await fixture.close();
    }
  }, 180_000);
});
