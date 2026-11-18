import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();
const getWorkspaceState = vi.fn();
const toast = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
}));

vi.mock("@zui/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: {
    getState: () => ({ getWorkspaceState }),
  },
}));

vi.mock("@zui/components/ui/toast.js", () => ({
  toast: (message: string) => toast(message),
}));

const { WorktreeMenu } = await import(
  "../src/components/workbench/zcode/host/WorktreeMenu.js"
);

const user = userEvent.setup();

afterEach(() => {
  cleanup();
  surfaceJson.mockReset();
  getWorkspaceState.mockReset();
  toast.mockReset();
});

async function closeWorktreeMenu() {
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

test("工作树菜单：列表渲染、新建 POST、删除确认、成功后刷新", async () => {
  const onDone = vi.fn();
  const worktrees = [
    { path: "/repo", head: "a".repeat(40), branch: "main" },
    { path: "/repo/wt-a", head: "b".repeat(40), branch: "feat-a" },
  ];
  getWorkspaceState.mockReturnValue({ activeTaskId: "task-1" });
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { path?: string };
      if (path.endsWith("/delete")) {
        return {
          git: { isRepo: true, branch: "main", branches: [], dirty: false },
        };
      }
      return {
        worktree: {
          path: `/repo/${body.path}`,
          head: "c".repeat(40),
          branch: "new",
        },
      };
    }
    return { worktrees };
  });

  render(<WorktreeMenu workspacePath="/repo" onDone={onDone} />);
  await user.click(screen.getByRole("button", { name: "工作树" }));
  await waitFor(() =>
    expect(surfaceJson.mock.calls[0]?.[0]).toBe(
      "/api/code/git/worktrees?taskId=task-1",
    ),
  );
  expect(screen.getByText("/repo/wt-a")).toBeTruthy();

  // 新建
  await user.type(screen.getByLabelText("工作树目录"), "wt-new");
  await user.type(screen.getByLabelText("工作树分支"), "feat-new");
  await user.click(screen.getByRole("button", { name: "新建" }));
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/code/git/worktrees",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          taskId: "task-1",
          path: "wt-new",
          branch: "feat-new",
          createBranch: true,
        }),
      }),
    ),
  );
  expect(onDone).toHaveBeenCalled();

  // 删除
  await user.click(screen.getByRole("button", { name: "删除工作树 feat-a" }));
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/code/git/worktrees/delete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ taskId: "task-1", path: "/repo/wt-a" }),
      }),
    ),
  );
  expect(onDone).toHaveBeenCalledTimes(2);
  await closeWorktreeMenu();
});

test("无活跃 Task 时新建给可读提示，不发请求", async () => {
  getWorkspaceState.mockReturnValue({ activeTaskId: null });
  surfaceJson.mockImplementation(async () => ({ worktrees: [] }));
  render(<WorktreeMenu workspacePath="/repo" onDone={() => {}} />);
  await user.click(screen.getByRole("button", { name: "工作树" }));
  await user.type(screen.getByLabelText("工作树目录"), "wt-x");
  await user.type(screen.getByLabelText("工作树分支"), "b");
  await user.click(screen.getByRole("button", { name: "新建" }));
  expect(toast).toHaveBeenCalledWith("请先创建或选择 Code Task。");
  expect(surfaceJson).not.toHaveBeenCalledWith(
    "/api/code/git/worktrees",
    expect.objectContaining({ method: "POST" }),
  );
  await closeWorktreeMenu();
});
