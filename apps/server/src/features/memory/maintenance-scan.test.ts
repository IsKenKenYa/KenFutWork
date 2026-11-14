import { describe, expect, it } from "vitest";
import { runMemoryMaintenanceScan } from "./maintenance-scan.js";

const actor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: null,
};

describe("记忆整理周期扫描", () => {
  it("记忆关闭时直接跳过，不列项目", async () => {
    const listProjects = () => {
      throw new Error("不应读取项目");
    };
    expect(
      await runMemoryMaintenanceScan({
        actor,
        isEnabled: async () => false,
        listProjects,
        maintain: async () => undefined,
      }),
    ).toEqual({ skipped: true, maintained: [], failed: [] });
  });

  it("Code 与 Design 的项目各整理一次", async () => {
    const maintained: string[] = [];
    const result = await runMemoryMaintenanceScan({
      actor,
      isEnabled: async () => true,
      listProjects: async (_actor, kind) =>
        kind === "code" ? [{ id: "code-1" }] : [{ id: "design-1" }],
      maintain: async (projectId) => {
        maintained.push(projectId);
      },
    });
    expect(result).toEqual({
      skipped: false,
      maintained: ["code-1", "design-1"],
      failed: [],
    });
  });

  it("单个项目失败只记录，同轮其它项目继续", async () => {
    const result = await runMemoryMaintenanceScan({
      actor,
      isEnabled: async () => true,
      listProjects: async (_actor, kind) =>
        kind === "code" ? [{ id: "a" }, { id: "b" }] : [{ id: "c" }],
      maintain: async (projectId) => {
        if (projectId === "b") throw new Error("目录不可写");
      },
    });
    expect(result).toEqual({
      skipped: false,
      maintained: ["a", "c"],
      failed: ["b"],
    });
  });
});
