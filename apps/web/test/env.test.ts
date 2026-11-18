import { afterEach, describe, expect, it, vi } from "vitest";

import { getServerBaseUrl, loadWebEnv } from "../src/lib/env";

describe("@kenfutwork/web env helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("只暴露 server base url：Supabase 两键已随 M1.5 删除", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:4010");

    const env = loadWebEnv();

    expect(env).toEqual({ serverBaseUrl: "http://localhost:4010" });
    // 回归锁：不再要求任何 Supabase 变量（缺了也不该抛错）
    expect(Object.keys(env)).toEqual(["serverBaseUrl"]);
  });

  it("不设 server base url 时退回同源/默认值（不再因缺 Supabase 键报错）", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "");

    expect(() => loadWebEnv()).not.toThrow();
  });

  it("empty NEXT_PUBLIC_SERVER_BASE_URL enables same-origin mode (empty base)", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "");

    expect(getServerBaseUrl()).toBe("");
  });

  it("未设置时走同源（不再是写死的 localhost:3001——见 env-base-url.test.ts 的真机事故）", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "");

    // 模拟变量未设置：直接置 undefined（stubEnv 空串=同源相对语义的对照组）
    const previous = process.env.NEXT_PUBLIC_SERVER_BASE_URL;
    delete process.env.NEXT_PUBLIC_SERVER_BASE_URL;
    try {
      expect(getServerBaseUrl()).toBe(window.location.origin);
    } finally {
      if (previous !== undefined) {
        process.env.NEXT_PUBLIC_SERVER_BASE_URL = previous;
      }
    }
  });

  it("reads getServerBaseUrl from process env when configured", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:4020");

    expect(getServerBaseUrl()).toBe("http://localhost:4020");
  });
});
