import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LocalAccessClientsSection } from "../src/components/workbench/local-access-clients-section";
import { LocalInstanceSection } from "../src/components/workbench/local-instance-section";

vi.mock("../src/lib/local-instance-context", () => ({
  useLocalInstance: () => ({
    instance: { instanceId: "instance", dataDir: "/data" },
  }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("浏览器显示本机路径与停机备份说明，不展示原生迁移假按钮", () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ dataDir: "/data", canMove: false })),
  );
  render(<LocalInstanceSection />);
  expect(
    screen.getByLabelText("数据目录").getAttribute("readonly"),
  ).not.toBeNull();
  expect(screen.queryByRole("button", { name: "迁移并重启" })).toBeNull();
  expect(screen.queryByRole("button", { name: "打开目录" })).toBeNull();
  expect(screen.getByText(/供应商 Key 以明文/)).toBeTruthy();
});

it.each([new Error("目标目录不是空目录。"), "目标目录不是空目录。"])(
  "桌面只调用明确IPC，迁移失败保留原实例并显示原因（%s）",
  async (failure) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ dataDir: "/data", canMove: true })),
    );
    const invoke = vi.fn().mockRejectedValue(failure);
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
    try {
      render(<LocalInstanceSection />);
      await waitFor(() =>
        expect(
          screen.getByLabelText("数据目录").getAttribute("readonly"),
        ).toBeNull(),
      );
      fireEvent.change(screen.getByLabelText("数据目录"), {
        target: { value: "/new-data" },
      });
      fireEvent.click(screen.getByRole("button", { name: "迁移并重启" }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("move_data_directory", {
          dataDir: "/new-data",
        }),
      );
      expect(await screen.findByText("目标目录不是空目录。")).toBeTruthy();
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__;
    }
  },
);

it("脚本授权令牌只从创建响应展示一次，列表不携带明文", async () => {
  const client = {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "api",
    label: "本机脚本",
    createdAt: "2026-10-05T00:00:00Z",
    expiresAt: null,
    revokedAt: null,
  };
  const fetch = vi.fn(async (_url: string, options: RequestInit) =>
    Response.json(
      options.method === "POST"
        ? { client, token: "explicit-secret-once" }
        : { clients: [client] },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const view = render(<LocalAccessClientsSection />);
  await screen.findByText("本机脚本");
  expect(screen.queryByText("explicit-secret-once")).toBeNull();
  fireEvent.change(screen.getByLabelText("令牌名字"), {
    target: { value: "新脚本" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建令牌" }));
  expect(await screen.findByText("explicit-secret-once")).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/api/local-access/clients"),
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "新脚本" }),
    },
  );
  view.unmount();
  render(<LocalAccessClientsSection />);
  await screen.findByText("本机脚本");
  expect(screen.queryByText("explicit-secret-once")).toBeNull();
});
