// @vitest-environment node
import { fileURLToPath } from "node:url";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import {
  clickOn,
  dispatchKey,
} from "../../server/src/features/browser/cdp-client.js";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import {
  type OriginalSessionBrowser,
  openOriginalSessionBrowser,
} from "./setup/code-public-browser.fixture.mjs";
import type { PublicFixture } from "./setup/code-public-session";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原SessionPane合并模型与思考菜单 integration",
  () => {
    it("原模型菜单选择真实BYOK模型后保持打开并在同一菜单调整思考强度", async () => {
      const httpLoading: Promise<{
        createCodeUiHttpFixture(): Promise<PublicFixture & { origin: string }>;
      }> = import(fixturePath);
      const [http, sessions] = await Promise.all([
        httpLoading,
        import("../../server/src/features/code-ui/host-session.fixture.js"),
      ]);
      const fixture = await http.createCodeUiHttpFixture();
      let host: Host | undefined;
      let browser: OriginalSessionBrowser | undefined;
      const failures: unknown[] = [];
      try {
        host = await sessions.createCodeSessionFixture(fixture.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "build", planEnabled: true },
        });
        const initial = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        const providerId = initial.config.modelSelection?.providerId;
        if (!providerId) throw new Error("原会话缺少真实供应商实例");
        const added = await host.client.request("/api/code-ui/rpc", {
          service: "providerSettingsService",
          method: "addPersonalModel",
          args: [
            providerId,
            "composer-menu-model",
            {
              optionSpecs: {
                reasoningLevel: {
                  values: ["low", "high"],
                  map: '{"reasoning_effort": reasoningLevel}',
                },
              },
            },
          ],
        });
        expect(added.status, JSON.stringify(added.body)).toBe(200);
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
        const trigger = '[data-testid="chat-model-select-trigger"]';
        await vi.waitFor(
          async () => {
            const ready = await page.evaluate<boolean>(`(() => {
              const trigger = document.querySelector(${JSON.stringify(trigger)});
              return Boolean(trigger && !trigger.disabled && trigger.getBoundingClientRect().width > 0);
            })()`);
            expect(ready, JSON.stringify(page.pageErrors)).toBe(true);
          },
          { timeout: 60_000 },
        );
        await clickOn(page.cdp, page.target.sessionId, { selector: trigger });
        let modelSelector = "";
        await vi.waitFor(async () => {
          const testId = await page.evaluate<string | null>(`(() => {
            const item = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
              .find((candidate) => candidate.textContent.trim() === "composer-menu-model");
            return item?.getAttribute("data-testid") ?? null;
          })()`);
          expect(testId, JSON.stringify(page.pageErrors)).not.toBeNull();
          modelSelector = `[data-testid=${JSON.stringify(testId)}]`;
        });
        await clickOn(page.cdp, page.target.sessionId, {
          selector: modelSelector,
        });
        const slider = 'input[type="range"][aria-label="思考强度"]';
        await vi.waitFor(async () => {
          expect(
            await page.evaluate(
              `document.querySelector(${JSON.stringify(slider)})?.getAttribute("aria-disabled")`,
            ),
            JSON.stringify(page.pageErrors),
          ).toBe("false");
        });
        await clickOn(page.cdp, page.target.sessionId, { selector: slider });
        await dispatchKey(page.cdp, page.target.sessionId, { key: "End" });
        await vi.waitFor(async () => {
          const state = await page.evaluate(`(() => {
            const config = document.querySelector('[data-testid="v4-model-config"]');
            const slider = document.querySelector(${JSON.stringify(slider)});
            return {
              model: config?.dataset.model,
              thought: config?.dataset.thought,
              planEnabled: config?.dataset.planEnabled,
              mode: config?.dataset.mode,
              sliderValue: slider?.value,
            };
          })()`);
          expect(state, JSON.stringify(page.pageErrors)).toEqual({
            model: "composer-menu-model",
            thought: "high",
            planEnabled: "true",
            mode: "build",
            sliderValue: "1",
          });
        });
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => browser?.close(),
          () => host?.dispose(),
          () => fixture.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "原模型菜单验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000);
  },
);
