import { describe, expect, it, vi } from "vitest";
import type { InstanceSqlClient } from "../persistence/types.js";
import {
  designProjectFingerprint,
  insertDesignTaskInTransaction,
} from "./design-task-metadata.js";

const project = {
  project_id: "project",
  canvas_id: "canvas",
  kind: "design",
  work_dir: "/new",
  canvas_root_directory: "/new",
  additional_directories: [],
};
const prepared = {
  instanceId: "instance",
  projectId: "project",
  canvasId: "canvas",
  projectFingerprint: designProjectFingerprint(project),
  rootDirectory: "/new",
  additionalDirectories: [],
};
const row = {
  task_id: "task",
  project_id: "project",
  canvas_id: "canvas",
  root_directory: "/old",
  additional_directories: [],
  sandbox_mode: "workspace-write",
  scope_generation: 1,
  branch_generation: 1,
  permission_mode: "build",
  plan_enabled: false,
  planning_epoch: 0,
  active_run_id: null,
  execution_state: "ready",
};
function fixture(rows: unknown[], canvasRoot = "/new") {
  const execute = vi.fn(
    async (_sql: string, _params?: readonly unknown[]) => 1,
  );
  const sql = {
    instanceId: "instance",
    execute,
    query: vi.fn(async () => []),
    queryOne: vi.fn(async (statement: string) =>
      statement.includes("select c.root_directory")
        ? { root_directory: canvasRoot, work_dir: canvasRoot }
        : (rows.shift() ?? null),
    ),
  } as unknown as InstanceSqlClient;
  return { sql, execute };
}
describe("Design Task creation snapshot", () => {
  it("reprovision retains original Task scope on the stable Project root", async () => {
    const f = fixture(
      [
        { ...project, work_dir: "/old", canvas_root_directory: "/old" },
        row,
        { task_id: "task" },
      ],
      "/old",
    );
    const result = await insertDesignTaskInTransaction(f.sql, "task", {
      ...prepared,
      rootDirectory: "/old",
    });
    expect(result.rootDirectory).toBe("/old");
    expect(result.canvasId).toBe("canvas");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects Project configuration race before publishing Task metadata", async () => {
    const f = fixture([
      {
        ...project,
        additional_directories: [{ path: "/other", access: "read" }],
      },
      null,
    ]);
    await expect(
      insertDesignTaskInTransaction(f.sql, "task", prepared),
    ).rejects.toThrow("项目目录已变更");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("inserts fixed Project scope on the supplied chat transaction", async () => {
    const f = fixture([
      project,
      null,
      { ...row, root_directory: "/new" },
      { task_id: "task" },
    ]);
    expect(
      (await insertDesignTaskInTransaction(f.sql, "task", prepared))
        .rootDirectory,
    ).toBe("/new");
    expect(f.execute.mock.calls[0]?.[1]).toEqual([
      "task",
      "project",
      "/new",
      "[]",
    ]);
  });
});
