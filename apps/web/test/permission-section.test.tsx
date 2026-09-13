// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PermissionSection } from "../src/components/permission-section";
import {
  approveToolPermission,
  fetchPermissionTier,
  updatePermissionTier,
} from "../src/lib/server-api";

const {
  fetchPermissionTierMock,
  updatePermissionTierMock,
  approveToolPermissionMock,
} = vi.hoisted(() => ({
  fetchPermissionTierMock: vi.fn(),
  updatePermissionTierMock: vi.fn(),
  approveToolPermissionMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchPermissionTier: fetchPermissionTierMock,
  updatePermissionTier: updatePermissionTierMock,
  approveToolPermission: approveToolPermissionMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  fetchPermissionTierMock.mockResolvedValue({ tier: "default" });
  updatePermissionTierMock.mockResolvedValue({ tier: "auto-approve" });
  approveToolPermissionMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("PermissionSection（DEC-4 权限设置 UI）", () => {
  it("加载并选中当前档位（default 单选）", async () => {
    render(<PermissionSection accessToken="token" />);
    const radio = (await screen.findByRole("radio", {
      name: /默认（推荐）/,
    })) as HTMLInputElement;
    await waitFor(() => {
      expect(radio.checked).toBe(true);
    });
  });

  it("模拟点击切换档位发起 PUT", async () => {
    const user = userEvent.setup();
    render(<PermissionSection accessToken="token" />);
    const auto = await screen.findByRole("radio", { name: /自动放行/ });
    await user.click(auto);
    await waitFor(() => {
      expect(updatePermissionTierMock).toHaveBeenCalledWith(
        "token",
        "auto-approve",
      );
    });
    expect(await screen.findByText("权限档位已更新")).toBeDefined();
  });

  it("工具审批：空工具名被拦截；填写后按粒度发起批准", async () => {
    const user = userEvent.setup();
    render(<PermissionSection accessToken="token" />);
    await screen.findByRole("radio", { name: /默认（推荐）/ });

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
});
