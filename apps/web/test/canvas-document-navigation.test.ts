import { expect, test } from "vitest";
import {
  hasPendingDocumentWorkspaceRestore,
  resolveDesignDocumentEntry,
} from "../src/components/workbench/zcode/host/canvasDocumentNavigation.js";
import {
  openCodeViewerSidePane,
  openDocumentSidePane,
} from "../src/components/workbench/zcode/lib/workspaceSidePane.js";

const scope = { projectId: "project-a", workspaceKey: "workspace-a" };
const canvas = {
  ...scope,
  resourceType: "canvas",
  documentId: "canvas-a",
  title: "画布 A",
} as const;

test("进入Design恢复当前或最近使用的画布，空项目才打开创建入口", () => {
  const first = openDocumentSidePane(null, canvas);
  const second = openDocumentSidePane(first, {
    ...canvas,
    documentId: "canvas-b",
    title: "画布 B",
  });
  const file = openCodeViewerSidePane(second, {
    type: "file",
    title: "report.md",
    path: "/report.md",
  });
  expect(resolveDesignDocumentEntry(first, scope)).toMatchObject({
    documentId: "canvas-a",
  });
  expect(
    resolveDesignDocumentEntry(file, scope, first.activeTabId),
  ).toMatchObject({ documentId: "canvas-a" });
  expect(resolveDesignDocumentEntry(null, scope)).toEqual({
    resourceType: "canvas",
    projectId: "project-a",
    title: "画布",
  });
  expect(
    resolveDesignDocumentEntry(second, {
      projectId: "project-b",
      workspaceKey: "workspace-b",
    }).documentId,
  ).toBeUndefined();
});

test("默认进入从已恢复canonical状态选择文档，显式打开仍可打开选择页", () => {
  const opened = openDocumentSidePane(null, canvas);
  const fallback = {
    ...scope,
    resourceType: "canvas",
    title: "画布",
    restoreExisting: true,
  } as const;
  const restored = openDocumentSidePane(opened, fallback);
  expect(restored.activeTabId).toBe(opened.activeTabId);
  expect(restored.tabs).toHaveLength(1);
  const explicit = openDocumentSidePane(restored, {
    ...scope,
    resourceType: "canvas",
    title: "画布",
  });
  expect(explicit.tabs).toHaveLength(2);
  expect(explicit.activeTabId).not.toBe(opened.activeTabId);
  expect(explicit.tabs.some((tab) => "restoreExisting" in tab)).toBe(false);
});

test("旧工作区状态不能当作新项目空态，归属相符或空态后继续恢复", () => {
  const opened = openDocumentSidePane(null, canvas);
  expect(hasPendingDocumentWorkspaceRestore(opened, "workspace-b")).toBe(true);
  expect(hasPendingDocumentWorkspaceRestore(opened, "workspace-a")).toBe(false);
  expect(hasPendingDocumentWorkspaceRestore(null, "workspace-b")).toBe(false);
});
