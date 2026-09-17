// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PermissionSection } from "../src/components/permission-section";

const {
  fetchPermissionSettingsMock,
  updatePermissionSettingsMock,
  approveToolPermissionMock,
} = vi.hoisted(() => ({
  fetchPermissionSettingsMock: vi.fn(),
  updatePermissionSettingsMock: vi.fn(),
  approveToolPermissionMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchPermissionSettings: fetchPermissionSettingsMock,
  updatePermissionSettings: updatePermissionSettingsMock,
  approveToolPermission: approveToolPermissionMock,
}));

const BASE_SETTINGS = {
  tier: "default" as const,
  automationTier: "default" as const,
  rules: { allow: [] as string[], deny: [] as string[] },
  browserControlEnabled: false,
  approvedForever: [] as string[],
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchPermissionSettingsMock.mockResolvedValue(BASE_SETTINGS);
  updatePermissionSettingsMock.mockResolvedValue({
    ...BASE_SETTINGS,
    tier: "auto-approve",
  });
  approveToolPermissionMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

/**
 * 权限设置 UI（DEC-4 + R5-3）：四档（含「自定义配置」）、常规/自动化两组、
 * 自定义规则编辑、工具审批。这几条是「点了真的会写服务端」的界面契约。
 */
describe("PermissionSection（权限设置 UI）", () => {
  it("加载并选中当前档位；常规与自动化两组各一份档位选择", async () => {
    render(<PermissionSection accessToken="token" />);
    const regularGroup = await screen.findByRole("group", {
      name: "常规任务档位",
    });
    const autoGroup = screen.getByRole("group", { name: "自动化任务档位" });
    const regular = (await within(regularGroup).findByRole("radio", {
      name: /默认（推荐）/,
    })) as HTMLInputElement;
    await waitFor(() => expect(regular.checked).toBe(true));
    // 两组各四个档（含第 4 档「自定义配置」）
    expect(within(regularGroup).getAllByRole("radio")).toHaveLength(4);
    expect(within(autoGroup).getAllByRole("radio")).toHaveLength(4);
    expect(
      within(autoGroup).getByRole("radio", { name: /自定义配置/ }),
    ).toBeInTheDocument();
    // 未选自定义档时不显示规则编辑区
    expect(screen.queryByLabelText("拒绝规则")).not.toBeInTheDocument();
  });

  it("点常规档位发起部分更新（只送 tier）", async () => {
    const user = userEvent.setup();
    render(<PermissionSection accessToken="token" />);
    const regularGroup = await screen.findByRole("group", {
      name: "常规任务档位",
    });
    await user.click(within(regularGroup).getByRole("radio", { name: /自动放行/ }));
    await waitFor(() => {
      expect(updatePermissionSettingsMock).toHaveBeenCalledWith("token", {
        tier: "auto-approve",
      });
    });
    expect(await screen.findByText(/常规任务档位已更新/)).toBeInTheDocument();
  });

  it("点自动化档位走 automationTier（与常规档互不影响）", async () => {
    const user = userEvent.setup();
    render(<PermissionSection accessToken="token" />);
    const autoGroup = await screen.findByRole("group", {
      name: "自动化任务档位",
    });
    await user.click(within(autoGroup).getByRole("radio", { name: /完全访问/ }));
    await waitFor(() => {
      expect(updatePermissionSettingsMock).toHaveBeenCalledWith("token", {
        automationTier: "full-access",
      });
    });
  });

  it("自定义档：显示规则编辑区，保存时把文本域转成 allow/deny 数组", async () => {
    fetchPermissionSettingsMock.mockResolvedValue({
      ...BASE_SETTINGS,
      tier: "custom",
      rules: { allow: ["write_file"], deny: ["mcp__*"] },
    });
    updatePermissionSettingsMock.mockResolvedValue({
      ...BASE_SETTINGS,
      tier: "custom",
    });
    const user = userEvent.setup();
    render(<PermissionSection accessToken="token" />);

    const deny = (await screen.findByLabelText("拒绝规则")) as HTMLTextAreaElement;
    const allow = (await screen.findByLabelText("放行规则")) as HTMLTextAreaElement;
    // 读回值铺进文本域（一行一条）
    expect(deny.value).toBe("mcp__*");
    expect(allow.value).toBe("write_file");

    await user.clear(deny);
    await user.type(deny, "mcp__*\nshell_*");
    await user.click(screen.getByRole("button", { name: "保存规则" }));
    await waitFor(() => {
      expect(updatePermissionSettingsMock).toHaveBeenCalledWith("token", {
        rules: { allow: ["write_file"], deny: ["mcp__*", "shell_*"] },
      });
    });
    expect(await screen.findByText("自定义规则已保存")).toBeInTheDocument();
  });

  it("工具审批：空工具名被拦截；填写后按粒度发起批准", async () => {
    const user = userEvent.setup();
    render(<PermissionSection accessToken="token" />);
    await screen.findByRole("group", { name: "常规任务档位" });

    await screen.findByRole("group", { name: "常规任务档位" });
    await user.click(screen.getByRole("button", { name: "批准" }));
    expect(await screen.findByText("请填写工具名")).toBeDefined();
    expect(approveToolPermissionMock).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("工具名"), "mcp__fs__write");
    await user.click(screen.getByLabelText("记忆粒度"));
    await user.click(await screen.findByRole("option", { name: "永久" }));
    await user.click(screen.getByRole("button", { name: "批准" }));
    await waitFor(() => {
      expect(approveToolPermissionMock).toHaveBeenCalledWith("token", {
        toolName: "mcp__fs__write",
        scope: "forever",
      });
    });
  });

  it("回归：PUT 响应缺 approvedForever 时用旧值兜底（曾把整页打崩）", async () => {
    fetchPermissionSettingsMock.mockResolvedValue({
      ...BASE_SETTINGS,
      approvedForever: ["write_file"],
    });
    // 服务端只回部分字段（形状漂移/老版本）
    updatePermissionSettingsMock.mockResolvedValue({
      tier: "auto-approve",
      automationTier: "default",
      rules: { allow: [], deny: [] },
      browserControlEnabled: false,
    });
    const user = userEvent.setup();
    render(<PermissionSection accessToken="token" />);
    const regularGroup = await screen.findByRole("group", {
      name: "常规任务档位",
    });
    await user.click(within(regularGroup).getByRole("radio", { name: /自动放行/ }));
    // 不崩，且旧的「已永久批准」还在
    expect(
      await screen.findByText(/已永久批准：write_file/),
    ).toBeInTheDocument();
  });

  it("已永久批准的工具在页面上如实列出", async () => {
    fetchPermissionSettingsMock.mockResolvedValue({
      ...BASE_SETTINGS,
      approvedForever: ["write_file", "execute"],
    });
    render(<PermissionSection accessToken="token" />);
    expect(
      await screen.findByText(/已永久批准：write_file、execute/),
    ).toBeInTheDocument();
  });
});
