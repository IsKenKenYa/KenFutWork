// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 回归（实测事故）：`/brand-kit` 是独立路由，挂载时 auth 会话还在加载（`session` 为
 * null）。原实现立刻发请求 → `getToken()` 抛 `ApiAuthError` → 被当成鉴权失败 →
 * **signOut()**：打开这一页就把用户登出了（实测进页面 0.6s 内 localStorage 的令牌
 * 被清空，工作台随后跳登录页）。修复后：等 `loading` 结束再发请求；仍无会话则去登录页。
 */
const {
  fetchBrandKitsMock,
  fetchBrandKitMock,
  replaceMock,
  signOutMock,
  authState,
} = vi.hoisted(() => ({
  fetchBrandKitsMock: vi.fn(),
  fetchBrandKitMock: vi.fn(),
  replaceMock: vi.fn(),
  signOutMock: vi.fn(),
  authState: {
    loading: true,
    session: null as null | { access_token: string },
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));

vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({
    session: authState.session,
    loading: authState.loading,
    signOut: signOutMock,
    user: authState.session
      ? { id: "u1", email: "u@test", displayName: null }
      : null,
  }),
}));

vi.mock("../src/lib/brand-kit-api", () => ({
  fetchBrandKits: fetchBrandKitsMock,
  fetchBrandKit: fetchBrandKitMock,
  createBrandKit: vi.fn(),
  updateBrandKit: vi.fn(),
  deleteBrandKit: vi.fn(),
  duplicateBrandKit: vi.fn(),
  createBrandKitAsset: vi.fn(),
  updateBrandKitAsset: vi.fn(),
  deleteBrandKitAsset: vi.fn(),
  uploadBrandKitAsset: vi.fn(),
}));

import { BrandKitPage } from "../src/components/brand-kit/brand-kit-page";

describe("品牌套件页的会话竞态", () => {
  beforeEach(() => {
    fetchBrandKitsMock.mockReset().mockResolvedValue({ brandKits: [] });
    fetchBrandKitMock.mockReset();
    replaceMock.mockReset();
    signOutMock.mockReset().mockResolvedValue(undefined);
    authState.loading = true;
    authState.session = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("会话加载中：不发请求、不 signOut（曾经会把自己登出）", async () => {
    render(<BrandKitPage />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchBrandKitsMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("会话就绪后只拉一次列表（不重复初始化）", async () => {
    authState.loading = false;
    authState.session = { access_token: "tok" };
    render(<BrandKitPage />);
    await waitFor(() => expect(fetchBrandKitsMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchBrandKitsMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("加载完成仍无会话：跳登录页，而不是 signOut", async () => {
    authState.loading = false;
    authState.session = null;
    render(<BrandKitPage />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
    expect(signOutMock).not.toHaveBeenCalled();
    expect(fetchBrandKitsMock).not.toHaveBeenCalled();
  });
});
