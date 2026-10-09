import { describe, expect, it } from "vitest";

import {
  capBody,
  createNetworkBuffer,
  formatRequest,
  isTextMime,
  NETWORK_BODY_LIMIT_CHARS,
  shortenUrl,
} from "./network-log.js";

/**
 * 网络请求缓冲：一条请求经历「发出 → 响应/失败」多个 CDP 事件，记录要**就地更新**并且
 * **seq 在发出时就定**——否则客户端按 seq 增量拉时会错位（漏掉后补的状态码）。
 */
describe("网络请求缓冲", () => {
  const at = "2026-09-18T00:00:00.000Z";

  it("发出时分配 seq，响应/失败补在同一条上（不新增条目）", () => {
    const buffer = createNetworkBuffer();
    buffer.started("r1", {
      method: "GET",
      url: "https://a.com/x",
      type: "xhr",
      at,
    });
    buffer.responded("r1", 200);
    expect(buffer.since(0)).toEqual([
      {
        seq: 1,
        method: "GET",
        url: "https://a.com/x",
        type: "xhr",
        status: 200,
        at,
      },
    ]);
    expect(buffer.latestSeq()).toBe(1);

    buffer.started("r2", { method: "POST", url: "https://a.com/y", at });
    buffer.failed("r2", "net::ERR_CONNECTION_REFUSED");
    const all = buffer.since(0);
    expect(all.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(all[1]).toMatchObject({
      method: "POST",
      failed: "net::ERR_CONNECTION_REFUSED",
    });
  });

  it("增量：since 只给更新的请求", () => {
    const buffer = createNetworkBuffer();
    buffer.started("r1", { method: "GET", url: "https://a.com/1", at });
    buffer.started("r2", { method: "GET", url: "https://a.com/2", at });
    expect(buffer.since(1).map((entry) => entry.url)).toEqual([
      "https://a.com/2",
    ]);
    expect(buffer.since(2)).toEqual([]);
  });

  it("陌生 requestId 的响应/失败被忽略（不炸、不乱建条目）", () => {
    const buffer = createNetworkBuffer();
    buffer.responded("不存在", 200);
    buffer.failed("不存在", "x");
    expect(buffer.since(0)).toEqual([]);
    expect(buffer.size()).toBe(0);
  });

  it("超过上限丢最旧的，且**后补的状态仍落到正确的那条上**（下标重建）", () => {
    const buffer = createNetworkBuffer(3);
    for (const id of ["r1", "r2", "r3", "r4"]) {
      buffer.started(id, { method: "GET", url: `https://a.com/${id}`, at });
    }
    // r1 被挤出去，索引整体前移：给 r3 补状态必须落到 r3 上
    buffer.responded("r3", 404);
    const entries = buffer.since(0);
    expect(entries.map((entry) => entry.url)).toEqual([
      "https://a.com/r2",
      "https://a.com/r3",
      "https://a.com/r4",
    ]);
    expect(entries[1]?.status).toBe(404);
    expect(entries[0]?.status).toBeUndefined();
  });

  it("clear 清空但 seq 不回退", () => {
    const buffer = createNetworkBuffer();
    buffer.started("r1", { method: "GET", url: "https://a.com/1", at });
    buffer.clear();
    expect(buffer.since(0)).toEqual([]);
    buffer.started("r2", { method: "GET", url: "https://a.com/2", at });
    expect(buffer.latestSeq()).toBe(2);
  });

  it("响应带 MIME、完成带耗时与响应体（都补在同一条上）", () => {
    const buffer = createNetworkBuffer();
    buffer.started("r1", {
      method: "POST",
      url: "https://a.com/api",
      type: "fetch",
      requestBody: '{"a":1}',
      at,
    });
    buffer.responded("r1", 200, { mimeType: "application/json" });
    buffer.finished("r1", 132, '{"ok":true}');
    expect(buffer.since(0)).toEqual([
      {
        seq: 1,
        method: "POST",
        url: "https://a.com/api",
        type: "fetch",
        requestBody: '{"a":1}',
        status: 200,
        mimeType: "application/json",
        durationMs: 132,
        responseBody: '{"ok":true}',
        at,
      },
    ]);
  });

  it("取响应体失败时只补耗时（finished 不带体也是合法路径）", () => {
    const buffer = createNetworkBuffer();
    buffer.started("r1", { method: "GET", url: "https://a.com/x", at });
    buffer.finished("r1", 8);
    const entry = buffer.get("r1");
    expect(entry?.durationMs).toBe(8);
    expect(entry?.responseBody).toBeUndefined();
  });

  it("get 按 requestId 取（取响应体前查 MIME/体积用）；陌生 id 回 undefined", () => {
    const buffer = createNetworkBuffer();
    buffer.started("r1", { method: "GET", url: "https://a.com/x", at });
    expect(buffer.get("r1")?.url).toBe("https://a.com/x");
    expect(buffer.get("r2")).toBeUndefined();
  });
});

describe("网络体采集口径", () => {
  it("文本类 MIME 判定：text/json/xml/js/表单 收，图片/字体/视频不收", () => {
    for (const mime of [
      "text/html",
      "text/plain; charset=utf-8",
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-www-form-urlencoded",
      "application/vnd.api+json",
    ]) {
      expect(isTextMime(mime), mime).toBe(true);
    }
    for (const mime of [
      undefined,
      "",
      "image/png",
      "font/woff2",
      "video/mp4",
      "application/octet-stream",
      "application/pdf",
    ]) {
      expect(isTextMime(mime), String(mime)).toBe(false);
    }
  });

  it("截断：超上限补 `…`（告诉读者这不是全文），不超原样", () => {
    expect(capBody("short")).toBe("short");
    const long = "x".repeat(NETWORK_BODY_LIMIT_CHARS + 10);
    const capped = capBody(long);
    expect(capped.length).toBe(NETWORK_BODY_LIMIT_CHARS + 1);
    expect(capped.endsWith("…")).toBe(true);
  });
});

describe("一行显示", () => {
  it("折成「方法 URL → 状态/失败」", () => {
    const base = { seq: 1, method: "GET", url: "https://a.com/x", at: "t" };
    expect(formatRequest({ ...base, status: 200 })).toBe(
      "GET https://a.com/x → 200",
    );
    expect(formatRequest({ ...base, status: 500, type: "fetch" })).toBe(
      "GET https://a.com/x → 500 (fetch)",
    );
    expect(formatRequest({ ...base, failed: "ERR_ABORTED" })).toBe(
      "GET https://a.com/x → 失败：ERR_ABORTED",
    );
    expect(formatRequest(base)).toBe("GET https://a.com/x → 进行中");
  });

  it("URL 去 query 并截断（一行放得下才有人看）", () => {
    expect(shortenUrl("https://a.com/x?token=secret&page=2")).toBe(
      "https://a.com/x",
    );
    const long = `https://a.com/${"x".repeat(200)}`;
    expect(shortenUrl(long).endsWith("…")).toBe(true);
    expect(shortenUrl(long).length).toBeLessThanOrEqual(121);
  });
});
