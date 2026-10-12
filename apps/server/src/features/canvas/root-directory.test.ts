import { expect, it, vi } from "vitest";
import type { InstanceSqlClient } from "../persistence/types.js";
import { claimCanvasRootInTransaction } from "./root-directory.js";

function fixture(
  root: string | null,
  taskRoots: string[] = [],
  projectRoot = "/new-project-default",
) {
  const resolve = vi.fn(async () => projectRoot);
  const execute = vi.fn(async (_statement: string, params: unknown[]) => {
    root = String(params[1]);
    return 1;
  });
  const sql = {
    instanceId: "instance",
    queryOne: async () => ({
      root_directory: root,
      work_dir: projectRoot,
    }),
    query: async () =>
      [...new Set(taskRoots)].map((root_directory) => ({ root_directory })),
    execute,
  } as unknown as InstanceSqlClient;
  return { sql, execute, resolve, root: () => root };
}
it("first Canvas claims default once; changed Project default cannot rebind it", async () => {
  const f = fixture(null);
  expect(await claimCanvasRootInTransaction(f.sql, "canvas", f.resolve)).toBe(
    "/new-project-default",
  );
  const changed = vi.fn(async () => "/changed-default");
  await expect(
    claimCanvasRootInTransaction(f.sql, "canvas", changed),
  ).rejects.toThrow("目录不一致");
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it("Task and Canvas inherit the same stable Project root", async () => {
  const f = fixture(null, ["/old-task", "/old-task"], "/old-task");
  expect(await claimCanvasRootInTransaction(f.sql, "canvas", f.resolve)).toBe(
    "/old-task",
  );
  expect(f.root()).toBe("/old-task");
  expect(f.resolve).toHaveBeenCalledTimes(1);
});
it.each([
  [null, ["/one", "/two"]],
  ["/canvas", ["/other-task"]],
] as const)(
  "conflicting Canvas or Task roots fail before binding",
  async (root, roots) => {
    const f = fixture(root, [...roots]);
    await expect(
      claimCanvasRootInTransaction(f.sql, "canvas", f.resolve),
    ).rejects.toThrow("目录冲突");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  },
);
it("historical Project/Canvas directory split fails without rewriting either index", async () => {
  const f = fixture("/old", ["/old"], "/new-project-default");
  await expect(
    claimCanvasRootInTransaction(f.sql, "canvas", f.resolve),
  ).rejects.toThrow("显式迁移");
  expect(f.root()).toBe("/old");
  expect(f.execute).not.toHaveBeenCalled();
});
it("unavailable stable directory asks for explicit association without another root", async () => {
  const f = fixture("/old", [], "/old");
  f.resolve.mockRejectedValueOnce(new Error("ENOENT"));
  await expect(
    claimCanvasRootInTransaction(f.sql, "canvas", f.resolve),
  ).rejects.toThrow("重新关联");
  expect(f.execute).not.toHaveBeenCalled();
});
