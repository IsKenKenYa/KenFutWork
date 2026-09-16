import { describe, expect, it } from "vitest";
import {
  canGoBack,
  canGoForward,
  createHistory,
  currentUrl,
  goBack,
  goForward,
  MAX_HISTORY_ENTRIES,
  openUrl,
} from "../src/lib/browser-history";

/**
 * 右栏浏览器的面板内历史栈（用户口径：「浏览器好多东西你都没加」——参考图的浏览器面板有
 * 后退/前进/刷新）。这里锁栈语义：截断前进分支、越界不动、重复地址不入栈、上限。
 */
describe("浏览器面板历史栈", () => {
  it("空栈：没有当前页，后退前进都不可用", () => {
    const state = createHistory();
    expect(currentUrl(state)).toBe("");
    expect(canGoBack(state)).toBe(false);
    expect(canGoForward(state)).toBe(false);
  });

  it("打开页面后成为当前页，可以后退", () => {
    let state = createHistory();
    state = openUrl(state, "http://a.com/");
    state = openUrl(state, "http://b.com/");
    expect(currentUrl(state)).toBe("http://b.com/");
    expect(canGoBack(state)).toBe(true);
    expect(canGoForward(state)).toBe(false);

    state = goBack(state);
    expect(currentUrl(state)).toBe("http://a.com/");
    expect(canGoForward(state)).toBe(true);

    state = goForward(state);
    expect(currentUrl(state)).toBe("http://b.com/");
  });

  it("回退后再打开新地址：前进分支被截断（与浏览器一致）", () => {
    let state = createHistory();
    state = openUrl(state, "http://a.com/");
    state = openUrl(state, "http://b.com/");
    state = openUrl(state, "http://c.com/");
    state = goBack(state); // 回到 b
    state = openUrl(state, "http://d.com/");
    expect(currentUrl(state)).toBe("http://d.com/");
    expect(canGoForward(state)).toBe(false);
    expect(state.entries).toEqual([
      "http://a.com/",
      "http://b.com/",
      "http://d.com/",
    ]);
  });

  it("重复打开当前地址不入栈（后退键不原地打转）", () => {
    let state = createHistory();
    state = openUrl(state, "http://a.com/");
    const same = openUrl(state, "http://a.com/");
    expect(same).toBe(state);
    expect(state.entries.length).toBe(1);
  });

  it("越界时后退/前进都不动（不崩、也不吞掉当前页）", () => {
    let state = createHistory();
    state = openUrl(state, "http://a.com/");
    expect(goBack(state)).toBe(state);
    expect(goForward(state)).toBe(state);
  });

  it("空地址不入栈（地址栏空串不产生一条历史）", () => {
    const state = createHistory();
    expect(openUrl(state, "")).toBe(state);
  });

  it("超过上限时丢最旧的（只留最近 N 条）", () => {
    let state = createHistory();
    const total = MAX_HISTORY_ENTRIES + 10;
    for (let i = 0; i < total; i += 1) {
      state = openUrl(state, `http://site-${i}.com/`);
    }
    expect(state.entries.length).toBe(MAX_HISTORY_ENTRIES);
    expect(state.entries[0]).toBe(`http://site-${total - MAX_HISTORY_ENTRIES}.com/`);
    expect(currentUrl(state)).toBe(`http://site-${total - 1}.com/`);
    expect(canGoBack(state)).toBe(true);
  });
});
