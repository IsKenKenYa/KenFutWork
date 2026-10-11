import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitPane } from "@zui/GitPane.js";
import type {
  GitPaneDataset,
  GitPaneRepositoryState,
} from "@zui/hooks/useGitRepository.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initGit: vi.fn(),
  activeTaskId: "task-1" as string | null,
}));

vi.mock("@zui/hooks/useServices.js", () => ({
  useServices: () => ({
    gitService: {
      getDiff: vi.fn(async () => ({
        availability: "unavailable",
        patch: null,
        beforeContent: null,
        afterContent: null,
        summary: null,
      })),
    },
  }),
}));
vi.mock("@zui/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ theme: "system", codePreviewSettings: {} }),
}));
vi.mock("@zui/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}) as never,
}));
vi.mock("@zui/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: {
    getState: () => ({
      getWorkspaceState: () => ({ activeTaskId: mocks.activeTaskId }),
    }),
  },
}));
vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (...args: unknown[]) => mocks.initGit(...args),
}));

afterEach(() => {
  cleanup();
  mocks.initGit.mockReset();
  mocks.activeTaskId = "task-1";
});

// jsdom 不实现 matchMedia；resolveTheme（跟随系统主题）依赖它。
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

function emptyDataset(id: GitPaneDataset["id"], readonly: boolean): GitPaneDataset {
  return { id, readonly, sections: [], comparisonLabel: null, turnIndex: null };
}

function createState(
  overrides?: Partial<GitPaneRepositoryState>,
): GitPaneRepositoryState {
  return {
    workspaceKey: "/ws",
    summary: {
      workspacePath: "/ws",
      repoRoot: "/ws",
      workspaceInRepoPath: ".",
      autoRefreshWatchPaths: [],
      branchName: null,
      trackingBranchName: null,
      headRefType: "branch",
      ahead: 0,
      behind: 0,
      isDirty: false,
      isGitAvailable: true,
      isRepository: false,
    },
    identity: {
      userName: null,
      userEmail: null,
      nameSource: null,
      emailSource: null,
      scopeLabel: null,
    },
    placeholder: { enabled: false },
    loading: false,
    error: null,
    revision: 1,
    sourceOptions: [
      { id: "unstaged", count: 0, readonly: false, disabled: false },
      { id: "staged", count: 0, readonly: false, disabled: false },
      { id: "branch", count: 0, readonly: true, disabled: false },
      { id: "last-turn", count: 0, readonly: true, disabled: false },
    ],
    datasets: {
      unstaged: emptyDataset("unstaged", false),
      staged: emptyDataset("staged", false),
      branch: emptyDataset("branch", true),
      "last-turn": emptyDataset("last-turn", true),
    },
    ...overrides,
  };
}

function renderPane(
  gitState: GitPaneRepositoryState,
  onRefresh: () => void = vi.fn(),
) {
  return render(
    <ZCodeIntlProvider>
      <GitPane
        workspacePath="/ws"
        gitState={gitState}
        selectedSourceId="unstaged"
        fileChangeFindActiveIndex={0}
        fileChangeFindNavigationRequestId={0}
        fileChangeFindQuery=""
        onFileChangeFindMatchCountChange={() => {}}
        onSelectSource={() => {}}
        onClose={() => {}}
        onRefresh={onRefresh}
      />
    </ZCodeIntlProvider>,
  );
}

describe("GitPane 非仓库空态的「初始化仓库」动作", () => {
  it("非仓库空态渲染「初始化仓库」按钮", () => {
    renderPane(createState());
    expect(screen.getByRole("button", { name: "初始化仓库" })).toBeVisible();
  });

  it("已是仓库、加载中或报错时不出现初始化入口", () => {
    const { unmount } = renderPane(
      createState({
        summary: {
          ...createState().summary,
          isRepository: true,
          branchName: "main",
        },
      }),
    );
    expect(screen.queryByRole("button", { name: "初始化仓库" })).toBeNull();
    unmount();

    renderPane(createState({ loading: true }));
    expect(screen.queryByRole("button", { name: "初始化仓库" })).toBeNull();
    unmount();

    renderPane(createState({ error: "读取失败" }));
    expect(screen.queryByRole("button", { name: "初始化仓库" })).toBeNull();
  });

  it("点击携带当前 Task 调服务端 init，成功后刷新面板", async () => {
    mocks.initGit.mockResolvedValue({ git: { isRepo: true } });
    const onRefresh = vi.fn();
    renderPane(createState(), onRefresh);
    fireEvent.click(screen.getByRole("button", { name: "初始化仓库" }));
    await waitFor(() => {
      expect(mocks.initGit).toHaveBeenCalledWith(
        "/api/code/git/init",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ taskId: "task-1" }),
        }),
      );
    });
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it("失败显示可读原因且不刷新", async () => {
    mocks.initGit.mockRejectedValue(
      new Error("初始化仓库失败：fatal: cannot mkdir .git"),
    );
    const onRefresh = vi.fn();
    renderPane(createState(), onRefresh);
    fireEvent.click(screen.getByRole("button", { name: "初始化仓库" }));
    expect(
      await screen.findByText(/初始化仓库失败：fatal: cannot mkdir \.git/),
    ).toBeVisible();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("没有活跃 Task 时不发请求，提示先选择 Task", async () => {
    mocks.activeTaskId = null;
    renderPane(createState());
    fireEvent.click(screen.getByRole("button", { name: "初始化仓库" }));
    expect(await screen.findByText("请先创建或选择 Code Task。")).toBeVisible();
    expect(mocks.initGit).not.toHaveBeenCalled();
  });
});
