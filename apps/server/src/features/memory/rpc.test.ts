import { expect, it, vi } from "vitest";
import type { LocalActor } from "../local-instance/types.js";
import type { ProjectMemoryService } from "./project-memory.js";
import { createProjectMemoryRpc } from "./rpc.js";

const actor: LocalActor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: null,
};

function createMemory(overrides?: Partial<ProjectMemoryService>) {
  return {
    listProjectMemories: async () => [],
    readProjectMemoryFile: async () => ({ content: "", updatedAt: 0 }),
    listTrashedMemories: vi.fn(async () => [
      {
        id: "1700000000-abcdef12",
        fileName: "b.md",
        title: "结论乙",
        reason: "duplicate" as const,
        indexLine: "- [结论乙](b.md) — 同一结论",
        trashedAt: 1_700_000_000_000,
        restorable: true,
      },
    ]),
    restoreTrashedMemory: vi.fn(async () => ({ fileName: "b-restored.md" })),
    ...overrides,
  } as unknown as ProjectMemoryService;
}

it("回收区列表把内部 id 映射成界面用的 trashId", async () => {
  const rpc = createProjectMemoryRpc(createMemory());
  const result = await rpc.call(actor, "listTrashedMemories", [
    { projectId: "project-1" },
  ]);
  expect(result.result).toEqual([
    {
      trashId: "1700000000-abcdef12",
      fileName: "b.md",
      title: "结论乙",
      reason: "duplicate",
      indexLine: "- [结论乙](b.md) — 同一结论",
      trashedAt: 1_700_000_000_000,
      restorable: true,
    },
  ]);
});

it("恢复转发回收项标识并原样返回结果", async () => {
  const memory = createMemory();
  const rpc = createProjectMemoryRpc(memory);
  const result = await rpc.call(actor, "restoreTrashedMemory", [
    { projectId: "project-1", trashId: "1700000000-abcdef12" },
  ]);
  expect(memory.restoreTrashedMemory).toHaveBeenCalledWith(actor, {
    projectId: "project-1",
    trashId: "1700000000-abcdef12",
  });
  expect(result.result).toEqual({ fileName: "b-restored.md" });
});

it("参数缺失时直接拒绝，不落到服务层", async () => {
  const memory = createMemory();
  const rpc = createProjectMemoryRpc(memory);
  await expect(rpc.call(actor, "listTrashedMemories", [{ projectId: "  " }]))
    .rejects.toThrow("记忆项目参数无效");
  await expect(
    rpc.call(actor, "restoreTrashedMemory", [
      { projectId: "project-1", trashId: "" },
    ]),
  ).rejects.toThrow("回收项参数无效");
  expect(memory.restoreTrashedMemory).not.toHaveBeenCalled();
});
