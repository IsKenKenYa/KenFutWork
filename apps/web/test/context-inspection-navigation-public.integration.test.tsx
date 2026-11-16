// @vitest-environment node
import { contextRequestListSchema } from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import {
  pressKey,
  typeText,
} from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import {
  expectContentPreserved,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const opener = 'button[aria-label="上下文分析"]';
const inspector = '[role="dialog"][aria-label="上下文分析"]';
const requestPicker = `${inspector} .lc-br-pick`;

async function narrowViewport(page: OriginalSessionBrowser) {
  await page.cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 320, height: 448, deviceScaleFactor: 1, mobile: false },
    page.target.sessionId,
  );
  await vi.waitFor(async () => {
    expect(await page.evaluate("innerWidth")).toBe(320);
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(opener)})?.checkVisibility()`,
      ),
    ).toBe(true);
  });
}

async function focusInspectorEntry(page: OriginalSessionBrowser) {
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(opener)})?.checkVisibility()`,
      ),
    ).toBe(true),
  );
  await page.evaluate(
    `document.querySelector(${JSON.stringify(opener)}).focus()`,
  );
  const { cdp, target } = page;
  // 走真实键盘遍历，避免脚本聚焦掩盖键盘可见状态。
  await pressKey(cdp, target.sessionId, "Tab");
  await pressShiftTab(page);
  return page.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(opener)});
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      focused: document.activeElement === button,
      visible: rect.left >= 0 && rect.right <= innerWidth &&
        rect.top >= 0 && rect.bottom <= innerHeight,
      outlined: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
    };
  })()`);
}

async function pressShiftTab({ cdp, target }: OriginalSessionBrowser) {
  for (const type of ["keyDown", "keyUp"])
    await cdp.send(
      "Input.dispatchKeyEvent",
      { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 },
      target.sessionId,
    );
}

async function openWithKeyboard(page: OriginalSessionBrowser) {
  const { cdp, target } = page;
  // CDP 的 Enter 需显式附带字符，才能触发原生按钮的按键激活。
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await cdp.send(
    "Input.dispatchKeyEvent",
    { type: "keyDown", ...key, text: "\r" },
    target.sessionId,
  );
  await cdp.send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", ...key },
    target.sessionId,
  );
  await vi.waitFor(async () => {
    expect(
      await page.evaluate(`(() => {
        const dialog = document.querySelector(${JSON.stringify(inspector)});
        if (!dialog) return null;
        const rect = dialog.getBoundingClientRect();
        return {
          bounded: rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
          closeFocused: dialog.contains(document.activeElement) &&
            document.activeElement.textContent.trim() === "关闭",
          currentRequest: Boolean(dialog.querySelector('nav[aria-label="模型请求"] [aria-current="true"]')),
          contentInert: Boolean(document.querySelector('#conversation-column').closest('[inert]')),
          previewOpen: Boolean(document.querySelector('[data-slot="hover-card-content"]')),
        };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({
      bounded: true,
      closeFocused: true,
      currentRequest: true,
      contentInert: true,
      previewOpen: false,
    });
  });
}

async function expectFocusRestored(page: OriginalSessionBrowser) {
  await vi.waitFor(async () => {
    expect(
      await page.evaluate(`({
        open: Boolean(document.querySelector(${JSON.stringify(inspector)})),
        restored: document.activeElement?.matches(${JSON.stringify(opener)}),
      })`),
    ).toEqual({ open: false, restored: true });
  });
}

async function expectDialogTabFocus(page: OriginalSessionBrowser) {
  await pressShiftTab(page);
  expect(
    await page.evaluate(`(() => {
      const focused = document.activeElement;
      const dialog = document.querySelector(${JSON.stringify(inspector)});
      const style = getComputedStyle(focused);
      return {
        inside: dialog.contains(focused),
        label: focused.textContent.trim(),
        outlined: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
      };
    })()`),
  ).toEqual({ inside: true, label: "刷新", outlined: true });
}

async function readInspectorTheme(
  page: OriginalSessionBrowser,
  theme: "zai-light" | "zai-dark",
) {
  await page.evaluate(
    `window.dispatchEvent(new CustomEvent("kenfutwork:theme-preference", { detail: ${JSON.stringify(theme)} }))`,
  );
  return page.evaluate<{
    dark: boolean;
    background: string;
    foreground: string;
    border: string;
    selection: string;
    primary: string;
    card: string;
  }>(`(() => {
    const dialog = document.querySelector(${JSON.stringify(inspector)});
    const content = dialog.querySelector('.lc-root');
    const header = dialog.querySelector('header');
    const selected = dialog.querySelector('nav[aria-label="模型请求"] [aria-current="true"]');
    const mask = dialog.previousElementSibling;
    const probe = document.createElement('span');
    dialog.append(probe);
    const token = name => {
      probe.style.color = 'var(' + name + ')';
      return getComputedStyle(probe).color;
    };
    const surface = getComputedStyle(dialog);
    const row = getComputedStyle(selected);
    const background = token('--color-background');
    const foreground = token('--color-foreground');
    const result = {
      dark: document.documentElement.classList.contains('dark'),
      background, foreground,
      dialog: surface.backgroundColor,
      content: getComputedStyle(content).backgroundColor,
      ink: surface.color,
      contentInk: getComputedStyle(content).color,
      nativeScheme: surface.colorScheme,
      chart: getComputedStyle(content.querySelector('.lc-card')).backgroundColor,
      card: token('--color-card'),
      divider: getComputedStyle(header).borderBottomColor,
      border: token('--color-border'),
      selected: row.backgroundColor,
      selection: token('--color-selected'),
      marker: row.borderInlineStartColor,
      markerVisible: row.borderInlineStartWidth !== '0px',
      primary: token('--color-primary'),
      shaded: getComputedStyle(mask, '::after').backgroundColor !== 'rgba(0, 0, 0, 0)',
    };
    probe.remove();
    return result;
  })()`);
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "分析窗口和选中请求随工作台亮暗主题更新",
  async () => {
    await withTaskGroupPublicPage(
      async ({ page }) => {
        await focusInspectorEntry(page);
        await openWithKeyboard(page);
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              `Boolean(document.querySelector(${JSON.stringify(`${inspector} .lc-card`)}))`,
            ),
          ).toBe(true),
        );
        const read = async (theme: "zai-light" | "zai-dark") => {
          const palette = await readInspectorTheme(page, theme);
          const { background, foreground, border, selection, primary, card } =
            palette;
          expect(palette).toMatchObject({
            dark: theme === "zai-dark",
            dialog: background,
            content: background,
            ink: foreground,
            contentInk: foreground,
            nativeScheme: theme === "zai-dark" ? "dark" : "light",
            chart: card,
            divider: border,
            selected: selection,
            marker: primary,
            markerVisible: true,
            shaded: true,
          });
          return palette;
        };
        const light = await read("zai-light");
        const dark = await read("zai-dark");
        expect(light.background).not.toBe(dark.background);
        expect(light.foreground).not.toBe(dark.foreground);
        expect(await read("zai-light")).toEqual(light);
      },
      { seedTaskHistory: true, prepareTaskContent: false },
    );
  },
  180_000,
);

async function chooseAnalyzedRequest(
  page: OriginalSessionBrowser,
  label: string,
) {
  const before = await page.evaluate(`(() => {
    const picker = document.querySelector(${JSON.stringify(requestPicker)});
    picker.scrollIntoView({ block: 'center' });
    picker.focus();
    return { focused: document.activeElement === picker, expanded: picker.getAttribute('aria-expanded') };
  })()`);
  expect(before).toEqual({ focused: true, expanded: "false" });
  await pressKey(page.cdp, page.target.sessionId, "Enter");
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`({
        expanded: document.querySelector(${JSON.stringify(requestPicker)})?.getAttribute('aria-expanded'),
        active: document.activeElement?.outerHTML.slice(0, 240),
        role: document.activeElement?.getAttribute('role'),
      })`),
    ).toMatchObject({ expanded: "true", role: "combobox" }),
  );
  await typeText(page.cdp, page.target.sessionId, label);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `Array.from(document.querySelectorAll('.lc-br [role="option"]')).map(node => node.textContent.trim())`,
      ),
    ).toEqual([label]),
  );
  await pressKey(page.cdp, page.target.sessionId, "Enter");
}

async function expectAnalyzedRequest(
  page: OriginalSessionBrowser,
  sequence: number,
  output: string,
) {
  await vi.waitFor(async () => {
    const state = await page.evaluate<{
      list: string;
      picker: string;
      chart: string;
      detail: string;
      output: string;
      pickerFocused: boolean;
    }>(`(() => {
      const dialog = document.querySelector(${JSON.stringify(inspector)});
      const picker = dialog.querySelector('.lc-br-pick');
      const response = Array.from(dialog.querySelectorAll('details')).find(node => node.querySelector('summary')?.textContent === '模型响应');
      return {
        list: dialog.querySelector('nav [aria-current="true"] span')?.textContent,
        picker: picker?.textContent.trim(),
        chart: dialog.querySelector('.lc-bar[aria-pressed="true"][data-seq]')?.getAttribute('aria-label'),
        detail: dialog.querySelector('.context-inspection-summary h2')?.textContent,
        output: response?.querySelector('pre')?.textContent,
        pickerFocused: document.activeElement === picker,
      };
    })()`);
    expect(state).toEqual({
      list: `#${sequence} · 已完成`,
      picker: `请求 #${sequence}`,
      chart: expect.stringContaining(`请求 #${sequence} ·`),
      detail: `请求 #${sequence}`,
      output: expect.stringContaining(output),
      pickerFocused: true,
    });
  });
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "分类浏览器的请求切换同步列表、趋势和原响应，并保留键盘焦点",
  async () => {
    await withTaskGroupPublicPage(
      async (context) => {
        const { host, model, page } = context;
        expect(
          (await host.command("sendText", { text: "查看上下文请求选择" }))
            .status,
        ).toBe(200);
        await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        const finalOutput = "同次运行的第二条原响应";
        model.writeText(1, finalOutput);
        model.finish(1);
        const [latest, earlier] = await vi.waitFor(
          async () => {
            const response = await host.client.request("/api/code-ui/rpc", {
              service: "context-insights",
              method: "list",
              args: [{ taskId: host.sessionId }],
            });
            expect(response.status).toBe(200);
            const list = contextRequestListSchema.parse(
              response.body.result,
            ).requests;
            expect(list.map((r) => r.status)).toEqual([
              "completed",
              "completed",
            ]);
            expect(list[0]?.runId).toBe(list[1]?.runId);
            return list;
          },
          { timeout: 30_000 },
        );
        if (!latest || !earlier)
          throw new Error("同一次运行缺少两条上下文记录");
        await narrowViewport(page);
        await focusInspectorEntry(page);
        await openWithKeyboard(page);
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              `document.querySelectorAll('.lc-bar[data-seq]').length`,
            ),
          ).toBe(2),
        );
        await chooseAnalyzedRequest(page, `请求 #${earlier.sequence}`);
        await expectAnalyzedRequest(
          page,
          earlier.sequence,
          "read-context-fixture",
        );
        await chooseAnalyzedRequest(page, "最近已读取");
        await expectAnalyzedRequest(page, latest.sequence, finalOutput);
        await pressKey(page.cdp, page.target.sessionId, "Escape");
        await expectFocusRestored(page);
        await page.cdp.send(
          "Emulation.clearDeviceMetricsOverride",
          {},
          page.target.sessionId,
        );
        await expectContentPreserved(context);
        expect(model.requests).toHaveLength(2);
      },
      {
        modelOptions: {
          initialTool: {
            id: "read-context-fixture",
            name: "read_file",
            arguments: { file_path: "/分组操作保留内容.txt" },
          },
        },
      },
    );
  },
  180_000,
);

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "窄窗通过键盘打开上下文分析，返回原 Task 草稿和入口",
  async () => {
    await withTaskGroupPublicPage(
      async (context) => {
        const { page } = context;
        const { cdp, target } = page;
        await narrowViewport(page);
        const entry = await focusInspectorEntry(page);
        expect(entry).toMatchObject({ focused: true, visible: true });
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              'Boolean(document.querySelector(\'[data-slot="hover-card-content"][data-state="open"]\'))',
            ),
          ).toBe(true),
        );
        await openWithKeyboard(page);
        await pressKey(cdp, target.sessionId, "Escape");
        await expectFocusRestored(page);
        expect(entry).toHaveProperty("outlined", true);
        await openWithKeyboard(page);
        await expectDialogTabFocus(page);
        await pressKey(cdp, target.sessionId, "Escape");
        await expectFocusRestored(page);
        await cdp.send(
          "Emulation.clearDeviceMetricsOverride",
          {},
          target.sessionId,
        );
        await expectContentPreserved(context);
        expect(context.model.requests).toHaveLength(
          context.modelRequestCountBefore,
        );
      },
      { seedTaskHistory: true },
    );
  },
  180_000,
);
