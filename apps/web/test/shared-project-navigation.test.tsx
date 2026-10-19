import type { CodeUiWorkspace, zcodeUiProtocol } from "@kenfutwork/shared";
import type { WorkspaceTabState } from "@zui/store/tabStore.js";
import { expect, it } from "vitest";
import {
  conversationWorkContext,
  setCanvasConversationContext,
  withoutCanvasContext,
} from "../src/components/workbench/zcode/host/conversationWorkContext";
import {
  filterProjectTabs,
  projectSupportsMode,
} from "../src/components/workbench/zcode/host/SharedProjectNavigation";

const code: CodeUiWorkspace = {
  projectId: "bf472f30-b466-4e67-a3fa-1c1fbfb65822",
  path: "/same",
  name: "Code项目",
  kind: "code",
  enabledModes: ["code"],
  additionalDirectories: [],
};
const design: CodeUiWorkspace = {
  ...code,
  projectId: "648eaec1-9bfb-49f6-b5f7-74f47e68a7e9",
  kind: "design",
  name: "Design项目",
  enabledModes: ["design"],
};
const shared: CodeUiWorkspace = {
  ...code,
  projectId: "2d7c6264-34a8-4d85-8fe3-f1d53a7425bd",
  enabledModes: ["code", "design"],
};
const tab = (project: CodeUiWorkspace): WorkspaceTabState => ({
  id: project.projectId,
  kind: "workspace",
  workspacePath: project.path,
  workspaceIdentity: JSON.stringify([project.projectId, project.path]),
  label: project.name,
});
it("同目录项目仍按真实身份隔离；共享项目同时可见", () => {
  const projects = [code, design, shared],
    tabs = projects.map(tab);
  expect(
    filterProjectTabs(tabs, projects, "code").map((item) => item.id),
  ).toEqual([code.projectId, shared.projectId]);
  expect(
    filterProjectTabs(tabs, projects, "design").map((item) => item.id),
  ).toEqual([design.projectId, shared.projectId]);
  expect(projectSupportsMode(code, "design")).toBe(false);
});
it("托管目录的项目导航使用服务端名称，重命名不改目录或会话身份", () => {
  const opened = { ...tab(shared), label: "managed-directory-uuid" };
  const before = structuredClone(opened);
  const visible = filterProjectTabs([opened], [shared], "design");
  expect(visible[0]?.label).toBe(shared.name);
  const renamed = filterProjectTabs(
    [opened],
    [{ ...shared, name: "统一工作项目" }],
    "code",
  );
  expect(renamed[0]).toEqual({ ...opened, label: "统一工作项目" });
  expect(opened).toEqual(before);
});
it("发送上下文深复制选区；可移除画布且无文件目录授权字段", () => {
  setCanvasConversationContext("context-project", {
    canvasId: "canvas-a",
    title: "海报",
    selectedCanvasElements: [{ id: "element", x: 1 }],
    brandKitId: "brand",
  });
  const admitted: zcodeUiProtocol.ConversationWorkContext =
    conversationWorkContext("context-project", "design");
  setCanvasConversationContext("context-project", {
    canvasId: "canvas-b",
    title: "另一张",
    selectedCanvasElements: [{ id: "other", x: 9 }],
  });
  expect(admitted.canvasId).toBe("canvas-a");
  expect(admitted.selectedCanvasElements).toEqual([{ id: "element", x: 1 }]);
  expect(admitted).not.toHaveProperty("rootDirectory");
  expect(withoutCanvasContext(admitted).canvasId).toBeUndefined();
  expect(conversationWorkContext("context-project", "design").canvasId).toBe(
    "canvas-b",
  );
  expect(conversationWorkContext("context-project", "code")).toEqual({
    preset: "code",
  });
});
