import { describe, expect, it } from "vitest";

import { createCdpBrowserSession } from "./cdp-session.js";

/**
 * 开发者工具数据的**真机集成测试**（默认跳过：需要本机 Chrome 与网络）。
 *
 *   KENFUTWORK_CDP_IT=1 pnpm --filter @kenfutwork/server test -- devtools-data
 *
 * 为什么要真跑一次：控制台与网络的数据面全是 CDP 事件驱动的，替身能验形状、验不了「事件
 * 真的会来」——上一轮就吃过「注入报成功、页面上什么都没有」这种哑失败。这里开一个真实例、
 * 打开真页面，确认 console 消息与网络请求都被采到、`evaluate` 真在页面里执行。
 */
const enabled = process.env.KENFUTWORK_CDP_IT === "1";

describe.skipIf(!enabled)("开发者工具数据（真机）", () => {
  it("真页面：控制台消息 / 网络请求 / 执行表达式三条路都通", async () => {
    const session = createCdpBrowserSession({
      dataDir: `${process.env.TEMP ?? "."}/kenfutwork-cdp-it`,
    });
    try {
      const status = await session.connect({ headless: true });
      expect(status.status).toBe("connected");

      const dom = await session.navigate("https://example.com");
      expect(dom.title).toContain("Example");

      // ① 页面自己产生的请求被采到（document 至少一条 200）
      await new Promise((resolve) => setTimeout(resolve, 800));
      const requests = await session.requests(0);
      expect(requests.requests.length).toBeGreaterThan(0);
      expect(
        requests.requests.some(
          (entry) => entry.url.includes("example.com") && entry.status === 200,
        ),
      ).toBe(true);

      // ② 页面里打一条日志 + 抛一个异常，都被采到
      await session.evaluate('console.log("kfw-console-it", { ok: true })');
      await session.evaluate("(() => { throw new Error('kfw-boom'); })()");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const messages = await session.messages(0);
      expect(
        messages.messages.some((message) =>
          message.text.includes("kfw-console-it { ok: true }"),
        ),
      ).toBe(true);
      expect(
        messages.messages.some(
          (message) =>
            message.level === "error" && message.text.includes("kfw-boom"),
        ),
      ).toBe(true);

      // ③ 增量游标：拿到的 nextSeq 之后没有新消息
      const after = await session.messages(messages.nextSeq);
      expect(after.messages).toEqual([]);

      // ④ 表达式真的在页面里执行（返回页面的值，不是服务端的）
      const title = await session.evaluate("document.title");
      expect(title.text).toContain("Example");
    } finally {
      await session.disconnect();
    }
  }, 120_000);
});
