import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderSettings } from "@/components/provider-settings";
import {
  createProviderInstance,
  deleteProviderInstance,
  fetchProviderInstances,
  updateProviderInstance,
} from "@/lib/server-api";

vi.mock("@/lib/server-api", () => ({
  fetchProviderInstances: vi.fn(),
  createProviderInstance: vi.fn(),
  updateProviderInstance: vi.fn(),
  deleteProviderInstance: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchProviderInstances);
const mockedCreate = vi.mocked(createProviderInstance);
const mockedUpdate = vi.mocked(updateProviderInstance);
const mockedDelete = vi.mocked(deleteProviderInstance);

import type { ProviderInstanceResponse } from "@kenfutwork/shared";

const instance: ProviderInstanceResponse = {
  id: "inst-1",
  scope: "workspace",
  name: "我的网关",
  protocol: "openai-compatible",
  hasCredential: true,
  models: [{ id: "gpt-x", name: "GPT X", capability: "chat" }],
  headerKeys: [],
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

  it("自定义请求头（JSON）：合法对象随创建提交，非法 JSON 与数组被拦截", async () => {
    const user = userEvent.setup();
    mockedFetch.mockResolvedValue({ instances: [] });
    mockedCreate.mockResolvedValue(instance);
    render(<ProviderSettings accessToken="token" />);
    await user.click(screen.getByRole("button", { name: "添加供应商" }));
    await user.type(screen.getByLabelText("实例名称"), "opencode");
    await user.type(screen.getByLabelText("API Key"), "k");

    // 非法 JSON：拦在提交前（含 `[`/`{` 的值用 change 直填，避开 userEvent 的按键转义语法）
    await fireEvent.change(screen.getByLabelText("自定义请求头（JSON，可选）"), {
      target: { value: "[1,2]" },
    });
    await user.click(screen.getByRole("button", { name: "保存实例" }));
    expect(await screen.findByText(/必须是 JSON 对象/)).toBeDefined();
    expect(mockedCreate).not.toHaveBeenCalled();

    // 合法对象：值原样提交（只写通道）
    await fireEvent.change(screen.getByLabelText("自定义请求头（JSON，可选）"), {
      target: { value: '{"x-opencode-session":"{{sessionId}}"}' },
    });
    await user.click(screen.getByRole("button", { name: "保存实例" }));
    await waitFor(() => {
      expect(mockedCreate).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({
          name: "opencode",
          headers: { "x-opencode-session": "{{sessionId}}" },
        }),
      );
    });
  });

  it("列表只显示自定义头的键名，值不回显", async () => {
    mockedFetch.mockResolvedValue({
      instances: [{ ...instance, headerKeys: ["x-opencode-session"] }],
    });
    render(<ProviderSettings accessToken="token" />);
    expect(
      await screen.findByText(/自定义请求头：x-opencode-session（值不回显）/),
    ).toBeDefined();
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

  it("编辑既有实例：带出当前值，只提交改动字段", async () => {
    const user = userEvent.setup();
    const editing = {
      ...instance,
      baseUrl: "https://api.example.com/v1",
      headerKeys: ["x-opencode-session"],
    };
    mockedFetch.mockResolvedValue({ instances: [editing] });
    mockedUpdate.mockResolvedValue(editing);
    render(<ProviderSettings accessToken="token" />);
    await waitFor(() => {
      expect(screen.getByText("我的网关")).toBeDefined();
    });

    await user.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("编辑供应商实例")).toBeDefined();
    // 既有值带出；协议不可改（更新契约里没有 protocol）；API Key 只写不回显
    expect(screen.getByLabelText("实例名称")).toHaveProperty(
      "value",
      "我的网关",
    );
    expect(screen.queryByLabelText("协议")).toBeNull();
    expect(screen.getByText(/协议不可改/)).toBeDefined();
    expect(screen.getByLabelText("API Key（留空则不改）")).toHaveProperty(
      "value",
      "",
    );
    expect(
      screen.getByText(/已存：x-opencode-session（留空则保留；填 \{\} 清空）/),
    ).toBeDefined();

    // 只改名字：patch 里不该出现 apiKey / headers / models
    await user.clear(screen.getByLabelText("实例名称"));
    await user.type(screen.getByLabelText("实例名称"), "我的网关 v2");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => {
      expect(mockedUpdate).toHaveBeenCalledWith("token", "inst-1", {
        name: "我的网关 v2",
      });
    });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("编辑时填 {} 表示清空自定义头；无改动提交被拦下", async () => {
    const user = userEvent.setup();
    const editing = {
      ...instance,
      headerKeys: ["x-opencode-session"],
    };
    mockedFetch.mockResolvedValue({ instances: [editing] });
    mockedUpdate.mockResolvedValue(editing);
    render(<ProviderSettings accessToken="token" />);
    await waitFor(() => {
      expect(screen.getByText("我的网关")).toBeDefined();
    });
    await user.click(screen.getByRole("button", { name: "编辑" }));

    // 无改动 → 明确拦下，不发请求
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    expect(await screen.findByText(/没有需要保存的修改/)).toBeDefined();
    expect(mockedUpdate).not.toHaveBeenCalled();

    // 填 {} → 清空（而不是「无 headers 字段」）
    await fireEvent.change(screen.getByLabelText("自定义请求头（JSON，可选）"), {
      target: { value: "{}" },
    });
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => {
      expect(mockedUpdate).toHaveBeenCalledWith("token", "inst-1", {
        headers: {},
      });
    });
  });
});
