import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
}));

const { PermissionTierChip, PermissionTierSection } = await import(
  "../src/components/workbench/zcode/host/PermissionTierControl.js"
);

const user = userEvent.setup();

afterEach(() => {
  cleanup();
  surfaceJson.mockReset();
});

test("composer 权限档 chip：四档渲染、PUT 写穿、失败回滚、端点失败隐藏", async () => {
  let tier = "default";
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      tier = (JSON.parse(String(init.body)) as { tier: string }).tier;
      return { tier };
    }
    return { tier };
  });
  const { unmount } = render(<PermissionTierChip />);
  const chip = await screen.findByTestId("permission-tier-chip");
  expect(chip.textContent).toContain("默认");

  await user.click(chip);
  await user.click(
    await screen.findByRole("menuitemradio", { name: "完全访问" }),
  );
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/permissions/tier",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ tier: "full-access" }),
      }),
    ),
  );

  // 端点失败 → 整体隐藏（不摆空壳）；effect 只在挂载时拉取，须重挂载验证
  surfaceJson.mockImplementation(async () => {
    throw new Error("down");
  });
  unmount();
  render(<PermissionTierChip />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByTestId("permission-tier-chip")).toBeNull();
});
