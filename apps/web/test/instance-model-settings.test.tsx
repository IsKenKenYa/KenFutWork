import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
}));

const { InstanceModelSettings } = await import(
  "../src/components/workbench/zcode/host/InstanceModelSettings.js"
);

const user = userEvent.setup();

afterEach(() => {
  cleanup();
  surfaceJson.mockReset();
});

test("自动压缩开关读现值、PATCH 写穿、失败回滚", async () => {
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as {
        autoCompactEnabled: boolean;
      };
      return { settings: { autoCompactEnabled: body.autoCompactEnabled } };
    }
    return { settings: { autoCompactEnabled: false } };
  });
  render(<InstanceModelSettings />);
  const toggle = await screen.findByRole("switch", { name: "自动压缩" });
  // 开关在读到现值前禁用；先等启用（现值已加载）再断言与点击
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await user.click(toggle);
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/instance/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ autoCompactEnabled: true }),
      }),
    ),
  );
  await waitFor(() =>
    expect(toggle.getAttribute("aria-checked")).toBe("true"),
  );

  // 失败回滚：从 true 关到 false 的 PATCH 失败 → 回滚回 true
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") throw new Error("保存失败");
    return { settings: { autoCompactEnabled: true } };
  });
  await user.click(toggle);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-checked")).toBe("true"),
  );
});

test("读不到设置时开关禁用（宁严勿松，不摆假开关）", async () => {
  surfaceJson.mockImplementation(async () => {
    throw new Error("down");
  });
  render(<InstanceModelSettings />);
  const toggle = await screen.findByRole("switch", { name: "自动压缩" });
  expect(toggle.hasAttribute("disabled")).toBe(true);
});
