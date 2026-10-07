import { describe, expect, it } from "vitest";
import { TaskWorkspaceRegistry } from "../src/components/workbench/zcode/host/taskWorkspaceRegistry";

describe("Project默认与Task固定目录", () => {
  it("默认A改B后旧Task仍A，创建新Task解析到B；重复注册不重绑旧Task", () => {
    const registry = new TaskWorkspaceRegistry();
    const project = {
      projectId: "project",
      name: "项目",
      path: "/A",
      additionalDirectories: [],
    };
    registry.registerProjects([project]);
    registry.registerTask({
      taskId: "old-task",
      projectId: "project",
      workspacePath: "/A",
    });
    registry.registerProjects([{ ...project, path: "/B" }]);
    expect(registry.task("old-task")).toEqual({
      taskId: "old-task",
      projectId: "project",
      rootDirectory: "/A",
    });
    expect(registry.defaultFor("/A", "old-task")?.path).toBe("/B");
    expect(registry.defaultFor("/A")?.path).toBe("/B");
    registry.registerTask({
      taskId: "new-task",
      projectId: "project",
      workspacePath: "/B",
    });
    expect(registry.task("new-task")?.rootDirectory).toBe("/B");
    expect(registry.task("old-task")?.rootDirectory).toBe("/A");
  });
  it("共享同目录的两个Project按实际Task projectId取default，不通过path猜Task", () => {
    const registry = new TaskWorkspaceRegistry();
    registry.registerProjects([
      {
        projectId: "first",
        name: "一",
        path: "/shared",
        additionalDirectories: [],
      },
      {
        projectId: "second",
        name: "二",
        path: "/shared",
        additionalDirectories: [],
      },
    ]);
    expect(registry.projectForPath("/shared")).toBeNull();
    expect(
      registry.projectForPath("/shared", JSON.stringify(["second", "/shared"]))
        ?.projectId,
    ).toBe("second");
    expect(
      registry.projectForPath(
        "/shared",
        JSON.stringify(["unregistered", "/shared"]),
      ),
    ).toBeNull();
    registry.registerTask({
      taskId: "task",
      projectId: "second",
      workspacePath: "/shared",
    });
    registry.registerProjects([
      {
        projectId: "first",
        name: "一",
        path: "/first",
        additionalDirectories: [],
      },
      {
        projectId: "second",
        name: "二",
        path: "/second",
        additionalDirectories: [],
      },
    ]);
    expect(registry.defaultFor("/shared", "task")?.path).toBe("/second");
    expect(registry.task("task")?.projectId).toBe("second");
    expect(
      registry.defaultFor(
        "/shared",
        null,
        JSON.stringify(["second", "/shared"]),
      )?.path,
    ).toBe("/second");
    expect(
      registry.projectForPath(
        "/different",
        JSON.stringify(["second", "/shared"]),
      ),
    ).toBeNull();
  });
  it("Task身份变更拒绝，元信息不完整时不伪造默认目录", () => {
    const registry = new TaskWorkspaceRegistry();
    registry.registerTask({
      taskId: "task",
      projectId: "project",
      workspacePath: "/A",
    });
    expect(() =>
      registry.registerTask({
        taskId: "task",
        projectId: "project",
        workspacePath: "/B",
      }),
    ).toThrow("不合法变化");
    registry.registerTask({ taskId: "missing" });
    expect(registry.task("missing")).toBeNull();
    expect(registry.defaultFor("/unknown", "missing")).toBeNull();
  });
  it("刷新删除项目时不保留旧默认，历史Task目录不成为新项目默认", () => {
    const registry = new TaskWorkspaceRegistry();
    registry.registerProjects([
      { projectId: "old", name: "旧", path: "/A", additionalDirectories: [] },
    ]);
    registry.registerTask({
      taskId: "old-task",
      projectId: "old",
      workspacePath: "/A",
    });
    registry.replaceProjects([]);
    expect(registry.defaultFor("/A", "old-task")).toBeNull();
    expect(registry.defaultFor("/A")).toBeNull();
    registry.replaceProjects([
      { projectId: "new", name: "新", path: "/A", additionalDirectories: [] },
    ]);
    expect(registry.projectForPath("/A")?.projectId).toBe("new");
    expect(registry.defaultFor("/A", "old-task")).toBeNull();
    expect(registry.task("old-task")?.rootDirectory).toBe("/A");
  });
  it("旧草稿保留选中Project身份，另一个项目占用A不会把新Task默认从B抢走", () => {
    const registry = new TaskWorkspaceRegistry();
    registry.registerProjects([
      { projectId: "first", name: "一", path: "/A", additionalDirectories: [] },
      {
        projectId: "second",
        name: "二",
        path: "/A",
        additionalDirectories: [],
      },
    ]);
    registry.selectProject("first", "/A");
    registry.replaceProjects([
      { projectId: "first", name: "一", path: "/B", additionalDirectories: [] },
      {
        projectId: "second",
        name: "二",
        path: "/A",
        additionalDirectories: [],
      },
    ]);
    expect(registry.defaultFor("/A")).toMatchObject({
      projectId: "first",
      path: "/B",
    });
    registry.registerTask({
      taskId: "background",
      projectId: "second",
      workspacePath: "/A",
    });
    expect(registry.defaultFor("/A")).toMatchObject({
      projectId: "first",
      path: "/B",
    });
    registry.selectProject("second", "/A");
    expect(registry.defaultFor("/A")).toMatchObject({
      projectId: "second",
      path: "/A",
    });
  });
});
