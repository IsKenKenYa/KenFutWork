import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderSettings } from "@/components/provider-settings";
import {
  createProviderInstance,
  deleteProviderInstance,
  fetchProviderInstances,
} from "@/lib/server-api";

vi.mock("@/lib/server-api", () => ({
  fetchProviderInstances: vi.fn(),
  createProviderInstance: vi.fn(),
  deleteProviderInstance: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchProviderInstances);
const mockedCreate = vi.mocked(createProviderInstance);
const mockedDelete = vi.mocked(deleteProviderInstance);

import type { ProviderInstanceResponse } from "@loomic/shared";

const instance: ProviderInstanceResponse = {
  id: "inst-1",
  name: "我的网关",
  protocol: "openai-compatible",
  hasCredential: true,
  models: [{ id: "gpt-x", name: "GPT X", capability: "chat" }],
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("ProviderSettings（BYOK 供应商设置）", () => {
  it("加载并展示已有实例（凭证只显示已保存，不显示 Key）", async () => {
    mockedFetch.mockResolvedValue({ instances: [instance] });
    render(<ProviderSettings accessToken="token" />);
    await waitFor(() => {
      expect(screen.getByText("我的网关")).toBeDefined();
    });
    expect(screen.getByText(/1 个模型/)).toBeDefined();
    expect(screen.queryByText("sk-secret")).toBeNull();
  });

  it("空列表显示占位文案", async () => {
    mockedFetch.mockResolvedValue({ instances: [] });
    render(<ProviderSettings accessToken="token" />);
    await waitFor(() => {
      expect(screen.getByText("暂无供应商实例")).toBeDefined();
    });
  });

  it("点击「添加供应商」展开表单，校验缺 Key 并提交创建", async () => {
    const user = userEvent.setup();
    mockedFetch.mockResolvedValue({ instances: [] });
    mockedCreate.mockResolvedValue(instance);
    render(<ProviderSettings accessToken="token" />);

    await user.click(screen.getByRole("button", { name: "添加供应商" }));
    expect(screen.getByLabelText("新建供应商实例")).toBeDefined();

    // 缺名称：先报名称错误
    await user.click(screen.getByRole("button", { name: "保存实例" }));
    expect(await screen.findByText(/请填写实例名称/)).toBeDefined();
    expect(mockedCreate).not.toHaveBeenCalled();

    // 缺 Key：显示错误且不提交
    await user.type(screen.getByLabelText("实例名称"), "我的网关");
    await user.click(screen.getByRole("button", { name: "保存实例" }));
    expect(await screen.findByText(/请填写 API Key/)).toBeDefined();
    expect(mockedCreate).not.toHaveBeenCalled();

    // 填写后提交
    await user.type(screen.getByLabelText("API Key"), "sk-secret");
    await user.click(screen.getByRole("button", { name: "保存实例" }));
    await waitFor(() => {
      expect(mockedCreate).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({ name: "我的网关", apiKey: "sk-secret" }),
      );
    });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("非法模型 JSON 提交被拦截", async () => {
    const user = userEvent.setup();
    mockedFetch.mockResolvedValue({ instances: [] });
    render(<ProviderSettings accessToken="token" />);
    await user.click(screen.getByRole("button", { name: "添加供应商" }));
    await user.type(screen.getByLabelText("实例名称"), "x");
    await user.type(screen.getByLabelText("API Key"), "k");
    await user.clear(screen.getByLabelText("模型清单（JSON）"));
    await user.type(screen.getByLabelText("模型清单（JSON）"), "not-json");
    await user.click(screen.getByRole("button", { name: "保存实例" }));
    expect(await screen.findByText(/合法 JSON/)).toBeDefined();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("点击删除调用删除接口并刷新列表", async () => {
    const user = userEvent.setup();
    mockedFetch
      .mockResolvedValueOnce({ instances: [instance] })
      .mockResolvedValueOnce({ instances: [] });
    mockedDelete.mockResolvedValue(undefined);
    render(<ProviderSettings accessToken="token" />);
    await waitFor(() => {
      expect(screen.getByText("我的网关")).toBeDefined();
    });
    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => {
      expect(mockedDelete).toHaveBeenCalledWith("token", "inst-1");
    });
    await waitFor(() => {
      expect(screen.getByText("暂无供应商实例")).toBeDefined();
    });
  });
});
