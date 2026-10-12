import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
}));

const { PermissionTierSection } = await import(
  "../src/components/workbench/zcode/host/PermissionTierControl.js"
);

const user = userEvent.setup();

afterEach(() => {
  cleanup();
  surfaceJson.mockReset();
});

test("设置页权限分区：默认档与自动化任务档分别写 PUT", async () => {
  let view = { tier: "default", automationTier: "default" };
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      view = { ...view, ...body };
      return view;
    }
    return view;
  });
  render(<PermissionTierSection />);
  const control = await screen.findByTestId("settings-default-tier");
  await waitFor(() => expect(control.textContent).toContain("默认"));

  await user.click(control);
  await user.click(
    await screen.findByRole("menuitemradio", { name: "自动审批" }),
  );
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/permissions/tier",
      expect.objectContaining({
        body: JSON.stringify({ tier: "auto-approve" }),
      }),
    ),
  );

  await user.click(screen.getByLabelText("自动化任务档"));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "自定义" }),
  );
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/permissions/tier",
      expect.objectContaining({
        body: JSON.stringify({ automationTier: "custom" }),
      }),
    ),
  );
});
