import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const api = {
  fetchOpenDesignConfig: vi.fn(),
  updateOpenDesignConfig: vi.fn(),
};

vi.mock("@/lib/server-api", () => ({
  fetchOpenDesignConfig: (token: string | null) =>
    api.fetchOpenDesignConfig(token),
  updateOpenDesignConfig: (
    token: string | null,
    input: { frontendUrl: string | null; embedSecret: string | null },
  ) => api.updateOpenDesignConfig(token, input),
}));

const { OpenDesignSettingsSection } = await import(
  "@/components/workbench/open-design-settings-section"
);

afterEach(() => {
  cleanup();
  api.fetchOpenDesignConfig.mockReset();
  api.updateOpenDesignConfig.mockReset();
});

test("读取文件配置回填表单；未启用状态如实显示", async () => {
  api.fetchOpenDesignConfig.mockResolvedValue({
    frontendUrl: "http://127.0.0.1:7456",
    embedSecret: "paired",
    restartRequired: true,
    source: "file",
  });
  render(<OpenDesignSettingsSection accessToken="t" />);
  await waitFor(() =>
    expect(screen.getByTestId("od-config-status").textContent).toBe(
      "已保存 重启桌面后生效",
    ),
  );
  expect(screen.getByTestId<HTMLInputElement>("od-frontend-url").value).toBe(
    "http://127.0.0.1:7456",
  );
  expect(screen.getByTestId<HTMLInputElement>("od-embed-secret").value).toBe(
    "paired",
  );
});

test("env 生效中：状态行说明来源，保存按钮无改动时禁用", async () => {
  api.fetchOpenDesignConfig.mockResolvedValue({
    frontendUrl: "http://127.0.0.1:7456",
    embedSecret: "x",
    restartRequired: false,
    source: "env",
  });
  render(<OpenDesignSettingsSection accessToken="t" />);
  await waitFor(() =>
    expect(screen.getByTestId("od-config-status").textContent).toBe(
      "环境变量生效中",
    ),
  );
  const save = screen.getByRole("button", { name: "保存" });
  expect(save.hasAttribute("disabled")).toBe(true);
});

test("编辑后保存：提交两键（空串→null），回显服务端结果", async () => {
  const user = userEvent.setup();
  api.fetchOpenDesignConfig.mockResolvedValue({
    frontendUrl: null,
    embedSecret: null,
    restartRequired: false,
    source: "none",
  });
  api.updateOpenDesignConfig.mockResolvedValue({
    frontendUrl: "http://127.0.0.1:7456",
    embedSecret: null,
    restartRequired: true,
    source: "file",
  });
  render(<OpenDesignSettingsSection accessToken="t" />);
  await waitFor(() =>
    expect(screen.getByTestId("od-config-status").textContent).toBe("未启用"),
  );
  await user.type(
    screen.getByTestId("od-frontend-url"),
    "http://127.0.0.1:7456",
  );
  const save = screen.getByRole("button", { name: "保存" });
  expect(save.hasAttribute("disabled")).toBe(false);
  await user.click(save);
  await waitFor(() =>
    expect(api.updateOpenDesignConfig).toHaveBeenCalledWith("t", {
      frontendUrl: "http://127.0.0.1:7456",
      embedSecret: null,
    }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("od-config-status").textContent).toBe(
      "已保存 重启桌面后生效",
    ),
  );
});

test("读取失败不摆假表单：状态行如实报错", async () => {
  api.fetchOpenDesignConfig.mockRejectedValue(new Error("连不上"));
  render(<OpenDesignSettingsSection accessToken="t" />);
  await waitFor(() =>
    expect(screen.getByTestId("od-config-status").textContent).toContain(
      "读取失败",
    ),
  );
});
