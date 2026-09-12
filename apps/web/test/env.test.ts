import { afterEach, describe, expect, it, vi } from "vitest";

import { getServerBaseUrl, loadWebEnv } from "../src/lib/env";

describe("@loomic/web env helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads the browser-safe Supabase env and explicit server base url", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:4010");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", " https://example.supabase.co ");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", " anon-key ");

    const env = loadWebEnv();

    expect(env).toEqual({
      serverBaseUrl: "http://localhost:4010",
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
    });
  });

  it("rejects missing browser-safe Supabase env values", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    expect(() => loadWebEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });

  it("empty NEXT_PUBLIC_SERVER_BASE_URL enables same-origin mode (empty base)", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "");

    expect(getServerBaseUrl()).toBe("");
  });

  it("keeps the default localhost fallback when the variable is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "");

    // 模拟变量未设置：直接置 undefined（stubEnv 空串=同源语义的对照组）
    const previous = process.env.NEXT_PUBLIC_SERVER_BASE_URL;
    delete process.env.NEXT_PUBLIC_SERVER_BASE_URL;
    try {
      expect(getServerBaseUrl()).toBe("http://localhost:3001");
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
