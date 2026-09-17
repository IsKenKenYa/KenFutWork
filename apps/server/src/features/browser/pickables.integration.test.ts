import { describe, expect, it } from "vitest";

import { createCdpBrowserSession } from "./cdp-session.js";

/**
 * 元素拾取几何的**真机**验收（默认 skipped，会真起一个浏览器）：
 *
 *   KENFUTWORK_CDP_IT=1 pnpm --filter @kenfutwork/server exec vitest run pickables.integration
 *
 * 验的是整套设计里唯一没被单测证明的假设：**`DOM.getBoxModel` 给的坐标与视口截图对齐**
 * （先滚到顶 → 文档坐标 == 视口坐标）。所以页面用 `data:` URL + 绝对定位元素写死几何，
 * 断言回来的 box 与 CSS 一致——替身端点的测试只能验协议，验不了这个。
 */
const ENABLED = process.env.KENFUTWORK_CDP_IT === "1";

const PAGE = `data:text/html,${encodeURIComponent(
  `<!doctype html><html><head><meta charset="utf-8"><style>
     body { margin: 0 }
     #top { position: absolute; left: 200px; top: 100px; width: 120px; height: 40px }
     #below { position: absolute; left: 50px; top: 400px; width: 80px; height: 24px }
   </style><title>拾取测试页</title></head><body>
     <button id="top">顶上的按钮</button>
     <a id="below" href="https://example.com/x">下方链接</a>
   </body></html>`,
)}`;

describe.skipIf(!ENABLED)("可拾取元素的真实几何（CDP）", () => {
  it("box 与页面 CSS 一致，且几何按阅读顺序、截图落 blob", async () => {
    const uploaded: string[] = [];
    const session = createCdpBrowserSession({
      blob: {
        bucket: () => ({
          upload: async (path: string) => {
            uploaded.push(path);
          },
          resolveUrl: async (path: string) => `https://blob.test/${path}`,
          getPublicUrl: (path: string) => `https://blob.test/${path}`,
        }),
      } as never,
    });

    const status = await session.connect({ headless: true });
    expect(status.status).toBe("connected");
    try {
      await session.navigate(PAGE);
      const page = await session.pickables();
      console.log(
        "PICKABLES",
        JSON.stringify({
          url: page.url,
          title: page.title,
          hints: page.elements.map((e) => e.hint),
        }),
      );

      // 顺带钉住 readDom（browser_navigate / browser_snapshot 走的读页路径）：它读的是
      // Runtime.evaluate 的 `{result:{result:{value}}}` 信封——真机与替身端点若不一致，
      // 这里会先炸（替身端点的信封是手写的，容易与 Chrome 差一层）
      const dom = await session.snapshot();
      console.log(
        "READDOM",
        JSON.stringify({
          url: dom.url,
          title: dom.title,
          elements: dom.elements.length,
        }),
      );

      expect(page.viewport.width).toBeGreaterThan(0);
      expect(page.viewport.height).toBeGreaterThan(0);
      expect(uploaded).toHaveLength(1);
      expect(page.screenshotUrl).toContain("browser/");

      const button = page.elements.find(
        (element) => element.hint === "button#top",
      );
      // 定位提示优先用 id（`hitHint` 的既定优先级）
      const link = page.elements.find((element) => element.hint === "a#below");
      // CSS 写死的几何必须原样回来（±1px 容差：四舍五入到 0.1）
      expect(button?.box).toEqual({ x: 200, y: 100, width: 120, height: 40 });
      expect(link?.box).toEqual({ x: 50, y: 400, width: 80, height: 24 });
      // 阅读顺序：y 小的在前（DOM 里 button 也在前，这里再钉一次排序口径）
      const order = page.elements.map((element) => element.hint);
      expect(order.indexOf("button#top")).toBeLessThan(
        order.indexOf("a#below"),
      );
    } finally {
      await session.disconnect();
    }
  }, 60_000);
});
