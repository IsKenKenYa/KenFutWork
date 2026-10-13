import { randomUUID } from "node:crypto";
import { useComposerAttachmentUploadStore } from "@zui/store/composerAttachmentUploadStore.js";
import { createTabStore } from "@zui/store/tabStore.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
} from "@zui/v4/composer/composerDraftStore.js";
import { afterEach, expect, it, vi } from "vitest";
import { applyDirectoryRelinkStores } from "../src/components/workbench/zcode/host/directoryRelinkStores";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { TaskWorkspaceRegistry } from "../src/components/workbench/zcode/host/taskWorkspaceRegistry";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  useZCodeSessionStore.setState({ workspaces: {} });
  useComposerAttachmentUploadStore.setState({ scopes: {} });
});
it("actual 400 old-directory-still-exists response yields no recovery proof", async () => {
  const client = new CodeHttpChannelClient({ apiBase: "http://local" });
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          error: {
            code: "invalid_request",
            message: "原项目目录仍存在，不能重新关联。",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await client.directoryRelinkSnapshot(randomUUID())).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  client.dispose();
});
function fixture() {
  const projectId = randomUUID(),
    otherId = randomUUID(),
    taskId = randomUUID();
  const registry = new TaskWorkspaceRegistry();
  registry.registerProjects([
    { projectId, name: "项目", path: "/old", additionalDirectories: [] },
    {
      projectId: otherId,
      name: "另一项目",
      path: "/other",
      additionalDirectories: [],
    },
  ]);
  registry.registerTask({ taskId, projectId, workspacePath: "/old" });
  const otherTask = randomUUID();
  const childId = randomUUID();
  registry.registerTask({ taskId: childId, projectId, workspacePath: "/old" });
  registry.registerTask({
    taskId: otherTask,
    projectId: otherId,
    workspacePath: "/other",
  });
  const oldIdentity = JSON.stringify([projectId, "/old"]),
    nextIdentity = JSON.stringify([projectId, "/chosen"]),
    otherIdentity = JSON.stringify([otherId, "/other"]);
  const snapshot = {
    projectId,
    workDir: "/old",
    tasks: [{ taskId, scopeGeneration: 4, branchGeneration: 8 }],
  };
  const receipt = {
    projectId,
    workDir: "/chosen",
    affectedTaskIds: [taskId, childId],
    tasks: [
      {
        taskId,
        scopeGeneration: 5,
        branchGeneration: 9,
        status: "ready" as const,
      },
    ],
  };
  const tabs = createTabStore(null);
  const ownedTabId = tabs
    .getState()
    .addTab("/old", { workspaceIdentity: oldIdentity });
  const otherTabId = tabs
    .getState()
    .addTab("/other", { workspaceIdentity: otherIdentity });
  useZCodeSessionStore.getState().setActiveTaskId("/old", taskId, oldIdentity);
  useZCodeSessionStore
    .getState()
    .setActiveTaskId("/other", otherTask, otherIdentity);
  persistV4ComposerDraft("/old", oldIdentity, taskId, {
    text: "尚未发送 /old 的用户文字",
    editorStateJson: '{"text":"/old"}',
    mode: "build",
  });
  return {
    registry,
    tabs,
    ownedTabId,
    otherTabId,
    snapshot,
    receipt,
    taskId,
    childId,
    otherTask,
    projectId,
    oldIdentity,
    nextIdentity,
    otherIdentity,
  };
}
it("verified receipt moves only owned tabs/cache and preserves actual draft/other Project state", () => {
  const f = fixture();
  const beforeTabs = f.tabs.getState().tabs;
  const otherBucket =
    useZCodeSessionStore.getState().workspaces[f.otherIdentity];
  applyDirectoryRelinkStores(f.registry, f.tabs, f.snapshot, f.receipt);
  expect(f.tabs.getState().tabs.map((tab) => tab.id)).toEqual(
    beforeTabs.map((tab) => tab.id),
  );
  expect(
    f.tabs.getState().tabs.find((tab) => tab.id === f.ownedTabId),
  ).toMatchObject({
    id: f.ownedTabId,
    workspacePath: "/chosen",
    workspaceIdentity: f.nextIdentity,
  });
  expect(f.tabs.getState().tabs.find((tab) => tab.id === f.otherTabId)).toBe(
    beforeTabs.find((tab) => tab.id === f.otherTabId),
  );
  expect(f.tabs.getState().activeWorkspacePath).toBe("/other");
  expect(useZCodeSessionStore.getState().workspaces[f.otherIdentity]).toBe(
    otherBucket,
  );
  expect(
    useZCodeSessionStore.getState().workspaces[f.nextIdentity]?.activeTaskId,
  ).toBe(f.taskId);
  expect(
    readV4ComposerDraft("/chosen", f.nextIdentity, f.taskId),
  ).toMatchObject({
    text: "尚未发送 /old 的用户文字",
    editorStateJson: '{"text":"/old"}',
  });
  expect(readV4ComposerDraft("/old", f.oldIdentity, f.taskId)?.text).toBe(
    "尚未发送 /old 的用户文字",
  );
  expect(f.registry.task(f.otherTask)?.rootDirectory).toBe("/other");
  expect(f.registry.task(f.taskId)).toBeNull();
  expect(f.registry.task(f.childId)).toBeNull();
  f.registry.registerTask({
    taskId: f.taskId,
    projectId: f.projectId,
    workspacePath: "/chosen",
  });
  expect(() =>
    f.registry.registerTask({
      taskId: f.taskId,
      projectId: f.projectId,
      workspacePath: "/unverified",
    }),
  ).toThrow("不合法变化");
});
it("receipt cannot invalidate another Project's cached Task even with a valid root fence", () => {
  const f = fixture();
  expect(() =>
    applyDirectoryRelinkStores(f.registry, f.tabs, f.snapshot, {
      ...f.receipt,
      affectedTaskIds: [...f.receipt.affectedTaskIds, f.otherTask],
    }),
  ).toThrow("其它项目Task");
  expect(f.registry.task(f.otherTask)?.rootDirectory).toBe("/other");
  expect(f.registry.task(f.taskId)?.rootDirectory).toBe("/old");
});
it("bad receipt and destination draft collision leave every existing store unchanged", () => {
  const f = fixture();
  const oldTabs = f.tabs.getState().tabs;
  const oldBuckets = useZCodeSessionStore.getState().workspaces;
  expect(() =>
    applyDirectoryRelinkStores(f.registry, f.tabs, f.snapshot, {
      ...f.receipt,
      tasks: [
        {
          taskId: f.taskId,
          branchGeneration: 9,
          status: "ready" as const,
          scopeGeneration: 999,
        },
      ],
    }),
  ).toThrow("Task不一致");
  expect(f.tabs.getState().tabs).toBe(oldTabs);
  expect(useZCodeSessionStore.getState().workspaces).toBe(oldBuckets);
  persistV4ComposerDraft("/chosen", f.nextIdentity, f.taskId, {
    text: "目标位置原草稿",
  });
  expect(() =>
    applyDirectoryRelinkStores(f.registry, f.tabs, f.snapshot, f.receipt),
  ).toThrow("原草稿已保留");
  expect(f.registry.task(f.taskId)?.rootDirectory).toBe("/old");
  expect(f.tabs.getState().tabs).toBe(oldTabs);
  expect(readV4ComposerDraft("/chosen", f.nextIdentity, f.taskId)?.text).toBe(
    "目标位置原草稿",
  );
});
it("actual attachment buckets retain File objects and backup; in-flight uploads require manual retry", () => {
  const f = fixture();
  const file = new File(["hello"], "note.txt", { type: "text/plain" });
  const item = {
    id: randomUUID(),
    file,
    filename: "note.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    referenceOwnership: "composer" as const,
    uploadStatus: "uploading" as const,
    uploadProgress: 20,
    operationId: randomUUID(),
    autoRetryCount: 0,
    staged: false,
    adopted: false,
    showComplete: false,
    localZeroCopy: false,
  };
  const oldKey = `${f.oldIdentity}\u0000${f.taskId}`,
    nextKey = `${f.nextIdentity}\u0000${f.taskId}`;
  useComposerAttachmentUploadStore.setState({
    scopes: { [oldKey]: [item], unrelated: [item] },
  });
  const other = useComposerAttachmentUploadStore.getState().scopes.unrelated;
  applyDirectoryRelinkStores(f.registry, f.tabs, f.snapshot, f.receipt);
  expect(
    useComposerAttachmentUploadStore.getState().scopes[nextKey]?.[0],
  ).toMatchObject({
    file,
    operationId: item.operationId,
    uploadStatus: "failed",
    uploadErrorKind: "runtimeRestarted",
  });
  expect(useComposerAttachmentUploadStore.getState().scopes[oldKey]?.[0]).toBe(
    item,
  );
  expect(useComposerAttachmentUploadStore.getState().scopes.unrelated).toBe(
    other,
  );
});
it("local persistence failure rolls back cache/view without deleting the old draft", () => {
  const f = fixture();
  const oldTabs = f.tabs.getState().tabs;
  const oldBuckets = useZCodeSessionStore.getState().workspaces;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage blocked");
  });
  expect(() =>
    applyDirectoryRelinkStores(f.registry, f.tabs, f.snapshot, f.receipt),
  ).toThrow("原草稿已保留");
  expect(f.registry.task(f.taskId)?.rootDirectory).toBe("/old");
  expect(f.registry.identityFor(f.projectId, "/old")).toBe(f.oldIdentity);
  expect(f.tabs.getState().tabs).toBe(oldTabs);
  expect(useZCodeSessionStore.getState().workspaces).toBe(oldBuckets);
  expect(readV4ComposerDraft("/old", f.oldIdentity, f.taskId)?.text).toBe(
    "尚未发送 /old 的用户文字",
  );
});
it("host uses GET missing proof and one POST to the original Project; failed POST changes no cache", async () => {
  const f = fixture();
  const client = new CodeHttpChannelClient({ apiBase: "http://local" });
  client.workspaces.registerProjects([
    {
      projectId: f.projectId,
      name: "项目",
      path: "/old",
      additionalDirectories: [],
    },
  ]);
  const request = vi
    .spyOn(client, "request")
    .mockRejectedValueOnce(new Error("目录尚存在"));
  await expect(client.directoryRelinkSnapshot(f.projectId)).rejects.toThrow(
    "目录尚存在",
  );
  request.mockResolvedValueOnce(f.snapshot);
  expect(await client.directoryRelinkSnapshot(f.projectId)).toEqual(f.snapshot);
  request.mockRejectedValueOnce(new Error("真实资源未停止"));
  await expect(client.relinkDirectory(f.snapshot, "/chosen")).rejects.toThrow(
    "真实资源未停止",
  );
  expect(request.mock.calls.at(-1)).toEqual([
    `/api/projects/${f.projectId}/relink-directory`,
    {
      expectedWorkDir: "/old",
      nextWorkDir: "/chosen",
      expectedTasks: f.snapshot.tasks,
    },
  ]);
  expect(client.projectForPath("/old")?.path).toBe("/old");
  expect(request).toHaveBeenCalledTimes(3);
  client.dispose();
});
