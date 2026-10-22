import "@testing-library/jest-dom/vitest";
import { randomUUID } from "node:crypto";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import {
  TabStoreProvider,
  useTabStoreApi,
} from "@zui/store/TabStoreProvider.js";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import {
  CodeDirectoryRecoveryProvider,
  ProjectDirectoryRecovery,
} from "../src/components/workbench/zcode/host/ProjectDirectoryRecovery";
import {
  installCodeRootBrowser,
  restoreCodeRootBrowser,
} from "./setup/code-root-host-browser";

beforeEach(installCodeRootBrowser);
afterEach(async () => {
  await act(async () => {
    cleanup();
    // 原组件在下一轮事件循环恢复焦点，先完成清理再释放测试页面。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreCodeRootBrowser();
  localStorage.clear();
});
function Activate({ identity }: { identity: string }) {
  const tabs = useTabStoreApi();
  useLayoutEffect(() => {
    tabs.getState().addTab("/missing", { workspaceIdentity: identity });
  }, [tabs, identity]);
  return <ProjectDirectoryRecovery />;
}
async function fixture(missing: boolean, failure = false) {
  const projectId = randomUUID(),
    taskId = randomUUID();
  const client = new CodeHttpChannelClient({ apiBase: "http://local" });
  client.workspaces.registerProjects([
    { projectId, path: "/missing", name: "项目", additionalDirectories: [] },
  ]);
  const snapshot = {
    projectId,
    workDir: "/missing",
    tasks: [{ taskId, scopeGeneration: 1, branchGeneration: 1 }],
  };
  const proof = vi
    .spyOn(client, "directoryRelinkSnapshot")
    .mockImplementation(async () =>
      missing && !client.projectForPath("/selected") ? snapshot : null,
    );
  const post = vi
    .spyOn(client, "relinkDirectory")
    .mockImplementation(async () => {
      if (failure) throw new Error("真实资源未停止");
      return {
        projectId,
        workDir: "/selected",
        affectedTaskIds: [taskId],
        tasks: [
          { taskId, scopeGeneration: 2, branchGeneration: 2, status: "ready" },
        ],
      };
    });
  const refresh = vi
    .spyOn(client, "refreshWorkspaces")
    .mockResolvedValue([
      { projectId, path: "/selected", name: "项目", additionalDirectories: [] },
    ]);
  const accessor = client.services;
  const listing = vi.fn(async () => []);
  vi.spyOn(client, "directoryServices").mockReturnValue({
    ...accessor,
    systemService: {
      ...accessor.systemService,
      info: async () => ({ homedir: "/selected", platform: "linux" }),
    },
    fileService: { ...accessor.fileService, readdir: listing },
  });
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TabStoreProvider>
        <CodeDirectoryRecoveryProvider client={client}>
          <Activate identity={JSON.stringify([projectId, "/missing"])} />
        </CodeDirectoryRecoveryProvider>
      </TabStoreProvider>
    </ZCodeIntlProvider>,
  );
  await waitFor(() => expect(proof).toHaveBeenCalled());
  return { client, post, refresh, listing, snapshot };
}
it("no missing proof means no recovery entry", async () => {
  const f = await fixture(false);
  try {
    expect(
      screen.queryByRole("button", { name: "重新关联" }),
    ).not.toBeInTheDocument();
    expect(f.post).not.toHaveBeenCalled();
  } finally {
    f.client.dispose();
  }
});
it("original DirectoryBrowser cancel makes no POST; selecting a folder sends exactly one controlled relink", async () => {
  const f = await fixture(true);
  const user = userEvent.setup();
  try {
    await user.click(await screen.findByRole("button", { name: "重新关联" }));
    await user.click(await screen.findByRole("button", { name: "取消" }));
    expect(f.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "重新关联" }));
    const select = await screen.findByRole("button", { name: "选择此目录" });
    await waitFor(() => expect(select).toBeEnabled());
    await user.click(select);
    await waitFor(() =>
      expect(f.post).toHaveBeenCalledExactlyOnceWith(f.snapshot, "/selected"),
    );
    expect(f.listing).toHaveBeenCalledWith({ path: "/selected" });
    expect(f.refresh).toHaveBeenCalledTimes(1);
  } finally {
    f.client.dispose();
  }
});
it("failed POST stays reviewable and does not mutate registry or retry the operation", async () => {
  const f = await fixture(true, true);
  const user = userEvent.setup();
  try {
    await user.click(await screen.findByRole("button", { name: "重新关联" }));
    const select = await screen.findByRole("button", { name: "选择此目录" });
    await waitFor(() => expect(select).toBeEnabled());
    await user.click(select);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "真实资源未停止",
    );
    expect(f.client.projectForPath("/missing")?.path).toBe("/missing");
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.refresh).not.toHaveBeenCalled();
  } finally {
    f.client.dispose();
  }
});
