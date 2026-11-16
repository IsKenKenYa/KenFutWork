// @vitest-environment node
import { copyFile, readFile, unlink, writeFile } from "node:fs/promises";
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
        initialConfig: { mode: "build", planEnabled: false },
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
      const requireApproval = (toolName?: string) =>
        vi.waitFor(
          async () => {
            const current = protocol.conversationSnapshotSchema.parse(
              await snapshot(),
            );
            const pending = current.pendingInteractions.find(
              (entry) =>
                entry.payload.kind === "permission" &&
                (!toolName || entry.payload.toolName === toolName),
            );
            if (!pending) throw new Error("未看到插件工具的 Task 审批请求");
            return pending;
          },
          { timeout: 15_000 },
        );
      const acceptApproval = async (interactionId: string) => {
        if (!host) throw new Error("未建立 Task 宿主");
        const approved = await host.command("resolveInteraction", {
          interactionId,
          answer: { optionId: "allowOnce", action: "accept" },
        });
        expect(approved.status, JSON.stringify(approved.body)).toBe(200);
        expect(
          protocol.commandAckSchema.parse(approved.body.result).status,
        ).toBe("accepted");
      };
      const sent = await host.command("sendText", { text: "显示插件页面" });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      await acceptApproval((await requireApproval()).interactionId);
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
      await vi.waitFor(() => expect(model.requests).toHaveLength(3));
      const modelInput = JSON.stringify(model.requests[2]?.body);
      expect(modelInput).toContain("PUBLIC_RESULT");
      expect(modelInput).not.toContain("PRIVATE_VIEW");
      expect(modelInput).not.toContain(result.ref);
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
      const approveVisible = (argument: string) =>
        vi.waitFor(
          async () => {
            const clicked = await page.evaluate(`(() => {
              const args = document.querySelector('[data-mcp-page-tool-arguments]');
              const button = document.querySelector('[data-permission-option-kind="allowOnce"][aria-selected="true"]');
              if (!args?.textContent.includes(${JSON.stringify(argument)}) || !button?.checkVisibility()) return false;
              if (args.textContent.includes('PRIVATE_RESOURCE_TOKEN')) throw new Error('审批面板有私有参数');
              button.click();
              return true;
            })()`);
            expect(clicked, JSON.stringify(page.pageErrors)).toBe(true);
          },
          { timeout: 15_000 },
        );
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
      const requireHint = (hint: string) =>
        vi.waitFor(async () => {
          const alerts = await page.evaluate<string[]>(
            `Array.from(document.querySelectorAll('[role="alert"]'), node => node.textContent)`,
          );
          expect(alerts).toContain(hint);
          expect(alerts.join(" ")).not.toContain("PRIVATE_INVALID_PAGE");
          expect(await frameHeight()).toBeNull();
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
      const invalidPage = join(host.workspacePath, "invalid-mcp-page");
      await writeFile(invalidPage, "");
      await activate(page, "打开插件页面");
      await requireHint("无法读取插件页面，请检查插件资源。");
      await unlink(invalidPage);
      await writeFile(join(host.workspacePath, "interactive-mcp-page"), "");
      await activate(page, "打开插件页面");
      await requirePage();
      const resourceRead = "mcp__app_probe__read_resource";
      const resourceApproval = await requireApproval(resourceRead);
      const reads = join(host.workspacePath, "mcp-page-resource-reads");
      await expect(readFile(reads, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(JSON.stringify(resourceApproval)).not.toContain(
        "PRIVATE_RESOURCE_TOKEN",
      );
      await approveVisible("page://probe/items/approved");
      await requireApproval("mcp__app_probe__refresh_card");
      expect(await readFile(reads, "utf8")).toBe("approved\n");
      const calls = join(host.workspacePath, "mcp-page-calls");
      await expect(readFile(calls, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await approveVisible("from_page");
      await vi.waitFor(
        async () => {
          expect(await readFile(calls, "utf8")).toBe(
            "refresh_card:from_page\n",
          );
          expect(await frameHeight()).toBe("211px");
        },
        { timeout: 10_000 },
      );
      expect(await readFile(calls, "utf8")).toBe("refresh_card:from_page\n");
      await activate(page, "关闭插件页面");
      await requireClosed();
      await activate(page, "打开插件页面");
      await requirePage();
      expect((await requireApproval(resourceRead)).interactionId).not.toBe(
        resourceApproval.interactionId,
      );
      const stopped = await fixture.client.request(
        `/api/mcp/servers/${installed.body.server.id}`,
        { enabled: false },
        "PATCH",
      );
      expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
      const expired = "插件页面已失效，请重新运行工具。";
      await requireHint(expired);
      await activate(page, "打开插件页面");
      await requireHint(expired);
      await vi.waitFor(async () => {
        const current = protocol.conversationSnapshotSchema.parse(
          await snapshot(),
        );
        expect(current.pendingInteractions).toEqual([]);
        expect(JSON.stringify(current)).not.toContain("PRIVATE_RESOURCE_TEXT");
        expect(JSON.stringify(current)).not.toContain("PRIVATE_RESOURCE_TOKEN");
      });
      expect(await readFile(calls, "utf8")).toBe("refresh_card:from_page\n");
      expect(await readFile(reads, "utf8")).toBe("approved\n");
      expect(model.requests).toHaveLength(3);
    } finally {
      await browser?.close();
      await model.close();
      await host?.dispose();
      await fixture.close();
    }
  }, 180_000);
});
