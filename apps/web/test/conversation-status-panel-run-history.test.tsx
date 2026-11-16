import { cleanup, render, screen } from "@testing-library/react";
import type { GitRepositorySummary } from "@zcode/shared";
import { TID_CHAT_SUMMARY_PANEL } from "@zcode/shared";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { ServiceProvider } from "@zui/hooks/useServices";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore";
import { ConversationStatusPanel } from "@zui/v4/ConversationStatusPanel";
import { buildConversationStatusPanelModel } from "@zui/v4/conversationStatusPanelModel";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient.js";

const WORKSPACE_PATH = "/workspace/run-history";

const gitSummary: GitRepositorySummary = {
  workspacePath: WORKSPACE_PATH,
  repoRoot: WORKSPACE_PATH,
  workspaceInRepoPath: "",
  autoRefreshWatchPaths: [],
  branchName: "main",
  trackingBranchName: null,
  headRefType: "branch",
  ahead: 0,
  behind: 0,
  isDirty: true,
  isGitAvailable: true,
  isRepository: true,
};

afterEach(() => {
  cleanup();
  useZCodeSessionStore.getState().setActiveTaskId(WORKSPACE_PATH, null);
});

describe("运行记录入口不看 Git 状态", () => {
  it("无 Git 摘要时，有 Task 仍让面板保持渲染", () => {
    const model = buildConversationStatusPanelModel({ hasActiveTask: true });
    expect(model.runHistory).toBe(true);
    expect(model.hasContent).toBe(true);
  });

  it("无 Git 摘要时，没有 Task 也回到无内容", () => {
    const model = buildConversationStatusPanelModel({});
    expect(model.runHistory).toBe(false);
    expect(model.hasContent).toBe(false);
  });

  it("有 Git 摘要时运行记录事实仍然成立，交给渲染层避免重复", () => {
    const model = buildConversationStatusPanelModel({
      hasActiveTask: true,
      gitSummary,
      gitWorktreeChangeSummary: { added: 1, removed: 0 },
    });
    expect(model.git).not.toBeNull();
    expect(model.runHistory).toBe(true);
    expect(model.hasContent).toBe(true);
  });
});

function statusPanel(hasActiveTask = false, showGit = false) {
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <ConversationStatusPanel
          workspacePath={WORKSPACE_PATH}
          hasActiveTask={hasActiveTask}
          {...(showGit
            ? {
                gitSummary,
                gitWorktreeChangeSummary: { added: 1, removed: 0 },
                onRefreshGit: () => {},
              }
            : {})}
        />
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

describe("运行记录入口渲染", () => {
  it("无 Git 摘要但有 Task 时入口独立渲染且胶囊保留展开读数", () => {
    useZCodeSessionStore
      .getState()
      .setActiveTaskId(WORKSPACE_PATH, "task-run-history");
    render(statusPanel(true));

    expect(screen.getByTestId(TID_CHAT_SUMMARY_PANEL)).toBeTruthy();
    expect(screen.getAllByTestId("run-history-trigger")).toHaveLength(1);
    // 胶囊兜底读数是展开入口的可见落点，只有这一项时不能留下空白外壳。
    expect(screen.getAllByText("运行记录").length).toBeGreaterThan(1);
  });

  it("Git 工具出现或消失时，保留同一个运行记录入口和键盘焦点", () => {
    useZCodeSessionStore
      .getState()
      .setActiveTaskId(WORKSPACE_PATH, "task-run-history");
    const client = new CodeHttpChannelClient({
      apiBase: window.location.origin,
    });
    const view = render(statusPanel(true), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ServiceProvider services={client.services}>{children}</ServiceProvider>
      ),
    });
    try {
      const entry = screen.getByRole("button", { name: "运行记录" });
      entry.focus();

      view.rerender(statusPanel(true, true));
      expect(screen.getByText("Git 工具")).toBeTruthy();
      expect(screen.getByRole("button", { name: "运行记录" })).toBe(entry);
      expect(document.activeElement).toBe(entry);

      view.rerender(statusPanel(true));
      expect(screen.queryByText("Git 工具")).toBeNull();
      expect(screen.getByRole("button", { name: "运行记录" })).toBe(entry);
      expect(document.activeElement).toBe(entry);
    } finally {
      view.unmount();
      client.dispose();
    }
  });

  it("无 Git 摘要且无 Task 时不渲染面板", () => {
    render(statusPanel());
    expect(screen.queryByTestId(TID_CHAT_SUMMARY_PANEL)).toBeNull();
  });
});
