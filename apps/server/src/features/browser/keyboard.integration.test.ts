import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createCdpBrowserSession } from "./cdp-session.js";

async function selectPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string")
    throw new Error("独占浏览器测试缺少监听端口");
  return address.port;
}

const formPage = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
  <title>浏览器键盘验证</title>
  <form><label for="draft">草稿</label><input id="draft" required>
    <button type="submit">保存</button></form>
  <output>尚未保存</output>
  <script>
    let saves = 0;
    document.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      document.querySelector('output').textContent = document.querySelector('input').value + ' · ' + ++saves;
    });
  </script></html>`;

it.skipIf(process.env.KENFUTWORK_CDP_IT !== "1")(
  "Agent 与工作台面板的 Enter 提交原生表单，Tab 和 Space 保留原生按钮行为",
  async () => {
    const scratch = fileURLToPath(
      new URL("../../../../../.scratch", import.meta.url),
    );
    const dir = await mkdtemp(join(scratch, "cdp-keyboard-"));
    const browser = createCdpBrowserSession({ dataDir: dir });
    try {
      const status = await browser.connect({
        headless: true,
        port: await selectPort(),
      });
      expect(status, JSON.stringify(status)).toMatchObject({
        status: "connected",
        owned: true,
      });
      const page = await browser.navigate(
        `data:text/html,${encodeURIComponent(formPage)}`,
      );
      expect(page.title).toBe("浏览器键盘验证");
      await browser.click({ selector: "input" });
      await browser.type("草稿一");
      await browser.key("Enter");
      const output = () =>
        browser.evaluate("document.querySelector('output').textContent");
      await vi.waitFor(async () =>
        expect((await output()).text).toBe("草稿一 · 1"),
      );
      await browser.key("Tab");
      expect(
        (await browser.evaluate("document.activeElement.textContent")).text,
      ).toBe("保存");
      await browser.key("Space");
      await vi.waitFor(async () =>
        expect((await output()).text).toBe("草稿一 · 2"),
      );
      await browser.key("Enter");
      await vi.waitFor(async () =>
        expect((await output()).text).toBe("草稿一 · 3"),
      );
      await browser.input({ type: "key", key: "Enter" });
      await vi.waitFor(async () =>
        expect((await output()).text).toBe("草稿一 · 4"),
      );
    } finally {
      await browser.disconnect();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
