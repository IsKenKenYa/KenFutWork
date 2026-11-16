// @vitest-environment node
import { codeShellsResponseSchema } from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clickOn,
  pressKey,
} from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import { withTaskGroupPublicPage } from "./setup/code-task-groups-public.fixture.js";

const catalogPath = "/api/code/shells";
const toggle = '[data-testid="terminal-toggle"]';
const terminal = '[data-testid="terminal"]';
const retry = `${terminal} button[aria-label="重新读取 Shell 列表"]`;

const pausedRequest = z.object({
  headers: z.record(z.string(), z.string()),
});
const requestFacts = z.array(
  z.object({ path: z.string(), status: z.number().optional() }),
);

async function exerciseCatalogTransport(page: OriginalSessionBrowser) {
  const { cdp, target } = page;
  const pending: Promise<unknown>[] = [];
  let count = 0;
  const off = cdp.on("Fetch.requestPaused", (event, id) => {
    if (id !== target.sessionId || typeof event.requestId !== "string") return;
    const first = ++count === 1;
    // 第二次读取仍由真实宿主处理，只清除这一笔请求的认证标头。
    const headers =
      count === 2
        ? Object.entries(pausedRequest.parse(event.request).headers)
            .filter(([name]) => !/^cookie$|^authorization$/iu.test(name))
            .map(([name, value]) => ({ name, value }))
        : null;
    if (headers) headers.push({ name: "Cookie", value: "test-catalog=none" });
    const operation = cdp.send(
      first ? "Fetch.failRequest" : "Fetch.continueRequest",
      {
        requestId: event.requestId,
        ...(first ? { errorReason: "ConnectionReset" } : {}),
        ...(headers ? { headers } : {}),
      },
      target.sessionId,
    );
    pending.push(operation);
    void operation.catch(() => undefined);
  });
  await cdp.send(
    "Fetch.enable",
    { patterns: [{ urlPattern: `*${catalogPath}` }] },
    target.sessionId,
  );
  return {
    get count() {
      return count;
    },
    async close() {
      try {
        await cdp.send("Fetch.disable", {}, target.sessionId);
        await Promise.all(pending);
      } finally {
        off();
      }
    },
  };
}

function readTerminal(page: OriginalSessionBrowser) {
  return page.evaluate<{
    alert: string | null;
    menu: string | null;
    menuFocused: boolean;
    sameTab: boolean;
    controlsFit: boolean;
  } | null>(`(() => {
    const panel = document.querySelector(${JSON.stringify(terminal)});
    if (!panel?.checkVisibility()) return null;
    const alert = panel.querySelector('[role="alert"]');
    const menu = panel.querySelector('button[aria-label="Shell"]');
    const tab = panel.querySelector('[role="tab"][aria-selected="true"]');
    const bounds = panel.getBoundingClientRect();
    const controls = [panel.querySelector('[data-testid="terminal-close-button"]'),
      panel.querySelector(${JSON.stringify(retry)}), menu, alert].filter(Boolean);
    return {
      alert: alert?.textContent?.trim() ?? null,
      menu: menu?.textContent?.trim() ?? null,
      menuFocused: menu !== null && document.activeElement === menu,
      sameTab: Boolean(tab && tab === window.__terminalCatalogOriginalTab),
      controlsFit: controls.every(control => {
        const box = control.getBoundingClientRect();
        return box.width > 0 && box.left >= bounds.left && box.right <= bounds.right &&
          box.right <= innerWidth;
      }),
    };
  })()`);
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "终端 Shell 列表读取失败时显示重试并保留原终端标签",
  async () => {
    await withTaskGroupPublicPage(
      async ({ host, page, model }) => {
        const reply = await host.client.request(catalogPath);
        expect(reply.status).toBe(200);
        const catalog = codeShellsResponseSchema.parse(reply.body);
        const selected = catalog.shells.find(
          ({ id }) => id === catalog.resolvedShell,
        );
        if (!selected) throw new Error("测试机器没有可用的默认 Shell。");
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(`(() => {
              const button = document.querySelector(${JSON.stringify(toggle)});
              return Boolean(button?.checkVisibility() && !button.disabled);
            })()`),
          ).toBe(true),
        );
        const transport = await exerciseCatalogTransport(page);
        try {
          await clickOn(page.cdp, page.target.sessionId, { selector: toggle });
          await vi.waitFor(() => expect(transport.count).toBe(1));
          await vi.waitFor(async () =>
            expect(await readTerminal(page)).toMatchObject({
              alert: "无法读取 Shell 列表",
              menu: null,
            }),
          );
          await page.evaluate(`(() => {
            window.__terminalCatalogOriginalTab = document.querySelector(
              ${JSON.stringify(`${terminal} [role="tab"][aria-selected="true"]`)});
          })()`);
          await page.cdp.send(
            "Emulation.setDeviceMetricsOverride",
            { width: 390, height: 720, deviceScaleFactor: 1, mobile: false },
            page.target.sessionId,
          );
          await vi.waitFor(async () => {
            expect(await page.evaluate("innerWidth")).toBe(390);
            expect(await readTerminal(page)).toMatchObject({
              sameTab: true,
              controlsFit: true,
            });
          });
          expect(
            await page.evaluate(`(() => {
              const button = document.querySelector(${JSON.stringify(retry)});
              button?.focus();
              return Boolean(button && document.activeElement === button);
            })()`),
          ).toBe(true);
          await pressKey(page.cdp, page.target.sessionId, "Enter");
          await vi.waitFor(async () => {
            expect(await readTerminal(page)).toMatchObject({
              alert: "本机连接已失效，请从桌面重新打开。",
              menu: null,
              sameTab: true,
              controlsFit: true,
            });
            expect(
              await page.evaluate(
                `document.activeElement === document.querySelector(${JSON.stringify(retry)})`,
              ),
            ).toBe(true);
          });
          await pressKey(page.cdp, page.target.sessionId, "Enter");
          await vi.waitFor(async () =>
            expect(await readTerminal(page)).toMatchObject({
              alert: null,
              menu: selected.label,
              menuFocused: true,
              sameTab: true,
              controlsFit: true,
            }),
          );
          expect(transport.count).toBe(3);
          expect(
            requestFacts
              .parse(page.requests)
              .filter(({ path }) => path === catalogPath)
              .map(({ status }) => status ?? null),
          ).toEqual([null, 401, 200]);
          expect(model.requests).toHaveLength(0);
        } finally {
          await transport.close();
        }
      },
      { prepareTaskContent: false },
    );
  },
  120_000,
);
