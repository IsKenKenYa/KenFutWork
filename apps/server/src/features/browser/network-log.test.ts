import { describe, expect, it } from "vitest";

import {
  createNetworkBuffer,
  formatRequest,
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
