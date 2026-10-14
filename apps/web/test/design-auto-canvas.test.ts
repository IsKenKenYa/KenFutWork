import { describe, expect, it } from "vitest";
import { resolveDesignAutoCanvas } from "../src/components/workbench/zcode/host/designAutoCanvas";

/**
 * Design 主区「自动进画布」决策的回归锁（融合后从原 web lib 迁入，语义不变）。
 *
 * 历史事故：跨上下文残留的选中 id 曾把自动进画布整段挡掉（判「选中即保持」，
 * 但选中的项目根本不在本列表里），主区永远停在空态。这里的用例锁死：
 * 按本列表过滤、列表未回来不动作、空列表保持空态，不创建项目或画布。
 */
describe("resolveDesignAutoCanvas", () => {
  it("列表未回来（未 loaded）→ 不动作", () => {
    expect(
      resolveDesignAutoCanvas({
        creatingProject: false,
        projectsLoaded: false,
        projectIds: [],
        selectedProjectId: null,
      }),
    ).toEqual({ kind: "idle" });
  });

  it("正在建项目 → 不动作（避免与创建流程互相触发）", () => {
    expect(
      resolveDesignAutoCanvas({
        creatingProject: true,
        projectsLoaded: true,
        projectIds: ["p1"],
        selectedProjectId: null,
      }),
    ).toEqual({ kind: "idle" });
  });

  it("选中的 id 在本列表里 → 保持", () => {
    expect(
      resolveDesignAutoCanvas({
        creatingProject: false,
        projectsLoaded: true,
        projectIds: ["p1", "p2"],
        selectedProjectId: "p2",
      }),
    ).toEqual({ kind: "keep" });
  });

  it("选中 id 不在本列表（跨视图残留）→ 按第一个项目重选", () => {
    expect(
      resolveDesignAutoCanvas({
        creatingProject: false,
        projectsLoaded: true,
        projectIds: ["p1", "p2"],
        selectedProjectId: "code-project-id",
      }),
    ).toEqual({ kind: "select", projectId: "p1" });
  });

  it("没有选中且列表有项目 → 选第一个", () => {
    expect(
      resolveDesignAutoCanvas({
        creatingProject: false,
        projectsLoaded: true,
        projectIds: ["p1"],
        selectedProjectId: null,
      }),
    ).toEqual({ kind: "select", projectId: "p1" });
  });

  it("空列表 → 等待用户选择或创建", () => {
    expect(
      resolveDesignAutoCanvas({
        creatingProject: false,
        projectsLoaded: true,
        projectIds: [],
        selectedProjectId: null,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("空列表的再次进入仍不自动创建", () => {
    expect(
      resolveDesignAutoCanvas({
        creatingProject: false,
        projectsLoaded: true,
        projectIds: [],
        selectedProjectId: null,
      }),
    ).toEqual({ kind: "empty" });
  });
});
