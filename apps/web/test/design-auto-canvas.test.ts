import { describe, expect, it } from "vitest";

import { resolveDesignAutoCanvas } from "@/lib/design-auto-canvas";

/**
 * 回归：Design 模式「自动进画布」的判定。
 *
 * 关键用例是第二条——Code 模式残留的 selectedProjectId 必须在 Design 里被忽略，
 * 否则主区会停在居中编排器（画布开不出来），线上被用户当成「Design 抄了 Code 模式」。
 */
describe("resolveDesignAutoCanvas", () => {
  const base = {
    mode: "design" as const,
    activeTaskId: null,
    creatingProject: false,
    projectsLoaded: true,
    designProjectIds: [] as string[],
    selectedProjectId: null as string | null,
    autoCreateTried: false,
  };

  it("无选中项目时选中画布列表的第一个", () => {
    expect(
      resolveDesignAutoCanvas({
        ...base,
        designProjectIds: ["d1", "d2"],
      }),
    ).toEqual({ kind: "select", projectId: "d1" });
  });

  it("Code 项目 id 残留时不挡画布：照样选中第一个画布项目", () => {
    expect(
      resolveDesignAutoCanvas({
        ...base,
        designProjectIds: ["d1"],
        selectedProjectId: "code-workdir-1",
      }),
    ).toEqual({ kind: "select", projectId: "d1" });
  });

  it("已选中本模式项目则保持，不改变选择", () => {
    expect(
      resolveDesignAutoCanvas({
        ...base,
        designProjectIds: ["d1", "d2"],
        selectedProjectId: "d2",
      }),
    ).toEqual({ kind: "keep" });
  });

  it("列表为空且未尝试过：自动建空白画布", () => {
    expect(resolveDesignAutoCanvas(base)).toEqual({ kind: "create" });
  });

  it("列表为空但已尝试过：不再重试（避免反复发创建请求）", () => {
    expect(resolveDesignAutoCanvas({ ...base, autoCreateTried: true })).toEqual(
      { kind: "give-up" },
    );
  });

  it("列表尚未返回时不动作（否则会误建画布）", () => {
    expect(resolveDesignAutoCanvas({ ...base, projectsLoaded: false })).toEqual(
      { kind: "idle" },
    );
  });

  it("有激活任务 / 正在建项目 / 非 Design 模式都不动作", () => {
    expect(resolveDesignAutoCanvas({ ...base, activeTaskId: "t1" })).toEqual({
      kind: "idle",
    });
    expect(resolveDesignAutoCanvas({ ...base, creatingProject: true })).toEqual(
      { kind: "idle" },
    );
    expect(resolveDesignAutoCanvas({ ...base, mode: "code" })).toEqual({
      kind: "idle",
    });
  });
});
