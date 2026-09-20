import { describe, expect, it } from "vitest";

import {
  CODE_WORK_DIR_STORAGE_KEY,
  type CodeWorkDirSelection,
  loadCodeWorkDir,
  reconcileCodeWorkDir,
  saveCodeWorkDir,
  type WorkDirStorage,
} from "../src/lib/code-work-dir-preference.js";

/** 最小假存储（也能模拟抛错，覆盖「隐私模式写不进」那条分支）。 */
function fakeStorage(options: { throwOn?: "get" | "set" } = {}) {
  const map = new Map<string, string>();
  const storage: WorkDirStorage = {
    getItem(key) {
      if (options.throwOn === "get") throw new Error("blocked");
      return map.get(key) ?? null;
    },
    setItem(key, value) {
      if (options.throwOn === "set") throw new Error("quota");
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
  return { storage, map };
}

/**
 * 回归背景（2026-09-20 真机走查）：工作目录的选择原本只是组件 state，刷新即丢；
 * 而 Code 模式的 run 作用域取「选中项目的主画布」——没选中时服务端懒供给隐藏 code
 * 项目，**文件悄悄落进 tmp/sandbox/<canvasId>，不是用户配的目录**，界面上看不出差别。
 */
describe("Code 工作目录的本地记忆", () => {
  it("存了再读是同一个选择", () => {
    const { storage, map } = fakeStorage();
    saveCodeWorkDir(storage, { projectId: "p1", name: "test" });
    expect(map.has(CODE_WORK_DIR_STORAGE_KEY)).toBe(true);
    expect(loadCodeWorkDir(storage)).toEqual({ projectId: "p1", name: "test" });
  });

  it("传 null 即清空（「不在项目中工作」）", () => {
    const { storage, map } = fakeStorage();
    saveCodeWorkDir(storage, { projectId: "p1", name: "test" });
    saveCodeWorkDir(storage, null);
    expect(map.has(CODE_WORK_DIR_STORAGE_KEY)).toBe(false);
    expect(loadCodeWorkDir(storage)).toBeNull();
  });

  it("没存过 / 形状不对 / 空串，一律当没记过（不崩）", () => {
    const { storage, map } = fakeStorage();
    expect(loadCodeWorkDir(storage)).toBeNull();
    for (const bad of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ projectId: "p1" }),
      JSON.stringify({ projectId: "", name: "x" }),
      JSON.stringify({ projectId: "p1", name: "  " }),
      JSON.stringify({ projectId: 42, name: "x" }),
    ]) {
      map.set(CODE_WORK_DIR_STORAGE_KEY, bad);
      expect(loadCodeWorkDir(storage)).toBeNull();
    }
  });

  it("存储不可用（读/写抛错）不拖垮调用方", () => {
    const readBroken = fakeStorage({ throwOn: "get" });
    expect(loadCodeWorkDir(readBroken.storage)).toBeNull();
    const writeBroken = fakeStorage({ throwOn: "set" });
    expect(() =>
      saveCodeWorkDir(writeBroken.storage, { projectId: "p1", name: "t" }),
    ).not.toThrow();
  });

  it("storage 缺席（SSR / 测试环境）时是 no-op", () => {
    expect(() =>
      saveCodeWorkDir(undefined, { projectId: "p1", name: "t" }),
    ).not.toThrow();
    expect(loadCodeWorkDir(undefined)).toBeNull();
  });
});

describe("记忆与当前项目列表对账", () => {
  const projects = [
    { id: "p1", name: "test" },
    { id: "p2", name: "other" },
  ];

  it("项目还在 → 照旧选中（名字以服务端为准）", () => {
    expect(
      reconcileCodeWorkDir({ projectId: "p1", name: "旧名字" }, projects),
    ).toEqual({ projectId: "p1", name: "test" });
  });

  it("项目被删了、但同名项目还在（重建过）→ 跟着同名项目走", () => {
    expect(
      reconcileCodeWorkDir({ projectId: "gone", name: "test" }, projects),
    ).toEqual({ projectId: "p1", name: "test" });
  });

  it("项目彻底没了 → 不给指向空气的 id，只留名字（交给「按目录名补建」那条路）", () => {
    expect(
      reconcileCodeWorkDir({ projectId: "gone", name: "vanished" }, projects),
    ).toEqual({ projectId: null, name: "vanished" });
  });

  it("没记忆 → 两个都空", () => {
    expect(reconcileCodeWorkDir(null, projects)).toEqual({
      projectId: null,
      name: null,
    });
  });

  it("列表为空（还没拉到）时不会误判成「项目没了」而丢掉名字", () => {
    const saved: CodeWorkDirSelection = { projectId: "p1", name: "test" };
    expect(reconcileCodeWorkDir(saved, [])).toEqual({
      projectId: null,
      name: "test",
    });
  });
});
