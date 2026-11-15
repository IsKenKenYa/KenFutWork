// @vitest-environment node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { clickOn } from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import { clickExactText } from "./setup/code-public-browser-actions.js";
import {
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

async function prepareWorkSave({ fixture, page }: TaskGroupPublicPageContext) {
  const directory = join(fixture.directory, "work-save-documents");
  await mkdir(directory);
  const project = await fixture.client.request("/api/projects", {
    kind: "work",
    name: "文档回执项目",
    work_dir: directory,
  });
  expect(project.status, JSON.stringify(project.body)).toBe(201);
  for (const id of ["gridcraft", "wordcraft"]) {
    const root = join(fixture.directory, "work", "editors", id);
    await mkdir(root, { recursive: true });
    // 最小文档页只调用浏览器下载；生产 Work 宿主注入 Blob 保存桥。
    await writeFile(
      join(root, "index.html"),
      "<!doctype html><html><head><title>文档</title></head><body>文档</body></html>",
    );
  }
  // 公开 Root 夹具没有外层页面。此测试对真实保存 HTTP 的回执进行排队，
  // 按不同顺序交还宿主；内容和错误均来自实际项目文件接口。
  await page.evaluate(`(() => {
    window.__workReceipts = new Map();
    window.addEventListener('message', async event => {
      const data = event.data;
      if (event.source !== window || event.origin !== location.origin ||
          data?.type !== 'kenfutwork:work-save') return;
      const form = new FormData();
      for (const name of ['projectId', 'assetId', 'relativePath', 'mimeType']) {
        if (data[name]) form.append(name, data[name]);
      }
      form.append('file', new Blob([data.bytes], {type: data.mimeType}), data.fileName);
      const response = await fetch('/api/work/host/save', {method: 'POST', body: form});
      const body = await response.json();
      window.__workReceipts.set(data.fileName, {
        type: 'kenfutwork:work-save-result', saveId: data.saveId,
        ok: response.ok, relativePath: body.relativePath, error: body.error?.message,
      });
    });
  })()`);
  await clickExactText(page, '[role="radio"]', "Work");
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="work-engine-sidebar-open"]',
  });
  return directory;
}

async function openEditor(
  page: OriginalSessionBrowser,
  id: string,
  title: string,
) {
  const row = `div:has(> span[title=${JSON.stringify(id)}]) button`;
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(row)})?.textContent.trim()`,
      ),
    ).toBe("打开"),
  );
  // 保存回归只依赖该按钮的原始 onClick，不依赖引擎列表滚动后的鼠标坐标。
  await page.evaluate(`document.querySelector(${JSON.stringify(row)}).click()`);
  await vi.waitFor(async () => {
    const editor = await page.evaluate(`(() => {
      const frame = document.querySelector('iframe[title=${JSON.stringify(title)}]');
      return {
        ready: Boolean(frame?.contentWindow?.__kfwEditorSaveBridge),
        frames: [...document.querySelectorAll('iframe')].map(item => [item.title, item.src]),
        surface: document.querySelector('[data-workspace-main-view]')?.getAttribute('data-workspace-main-view'),
      };
    })()`);
    expect(
      editor,
      JSON.stringify({ editor, errors: page.pageErrors }),
    ).toMatchObject({ ready: true });
  });
}

async function saveFromEditor(
  page: OriginalSessionBrowser,
  title: string,
  fileName: string,
  text: string,
  ok: boolean,
) {
  await page.evaluate(`(() => {
    const frame = document.querySelector('iframe[title=${JSON.stringify(title)}]');
    const doc = frame.contentDocument;
    const editor = frame.contentWindow;
    const anchor = doc.createElement('a');
    anchor.download = ${JSON.stringify(fileName)};
    anchor.href = editor.URL.createObjectURL(new editor.Blob([${JSON.stringify(text)}], {type: 'text/plain'}));
    anchor.click();
  })()`);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `window.__workReceipts.get(${JSON.stringify(fileName)})`,
      ),
    ).toMatchObject({ ok }),
  );
}

async function deliverReceipt(page: OriginalSessionBrowser, fileName: string) {
  return page.evaluate<{ status: string | null; error: string | null }>(
    `(async () => {
      const receipt = window.__workReceipts.get(${JSON.stringify(fileName)});
      const seen = new Promise(resolve => {
        const listener = event => {
          if (event.data?.type !== receipt.type || event.data.saveId !== receipt.saveId) return;
          window.removeEventListener('message', listener);
          resolve();
        };
        window.addEventListener('message', listener);
      });
      window.postMessage(receipt, location.origin);
      await seen;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const surface = document.querySelector('[data-workspace-embedded-surface="work"]:not([hidden])');
      return {
        status: surface.querySelector('[role="status"]:not([aria-busy])')?.textContent ?? null,
        error: surface.querySelector('[role="alert"]')?.textContent ?? null,
      };
    })()`,
  );
}

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "连续保存与切换 Work 编辑器时只显示当前保存的真实回执",
  async () => {
    await withTaskGroupPublicPage(
      async (context) => {
        const { page } = context;
        const directory = await prepareWorkSave(context);
        await openEditor(page, "gridcraft", "表格");
        await saveFromEditor(page, "表格", "旧错误.xlsx", "", false);
        await saveFromEditor(page, "表格", "新版本.xlsx", "new workbook", true);
        const current = {
          status: `已保存 ${join(directory, "新版本.xlsx")}`,
          error: null,
        };
        expect(await deliverReceipt(page, "新版本.xlsx")).toEqual(current);
        const reordered = await deliverReceipt(page, "旧错误.xlsx");
        expect(await readFile(join(directory, "新版本.xlsx"), "utf8")).toBe(
          "new workbook",
        );

        await saveFromEditor(page, "表格", "旧页面.xlsx", "old workbook", true);
        await clickOn(page.cdp, page.target.sessionId, {
          selector: 'button[aria-label="返回编辑器列表"]',
        });
        await openEditor(page, "wordcraft", "文档");
        const fromClosedEditor = await deliverReceipt(page, "旧页面.xlsx");
        await saveFromEditor(page, "文档", "无内容.docx", "", false);
        expect(await deliverReceipt(page, "无内容.docx")).toEqual({
          status: null,
          error: "保存失败：保存内容为空。",
        });
        expect({ reordered, fromClosedEditor }).toEqual({
          reordered: current,
          fromClosedEditor: { status: null, error: null },
        });
      },
      { enableWork: true, prepareTaskContent: false },
    );
  },
  180_000,
);
