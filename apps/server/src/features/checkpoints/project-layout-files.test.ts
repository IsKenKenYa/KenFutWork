import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { PersistenceService } from "../persistence/types.js";
import { createProjectLayoutFiles } from "./project-layout-files.js";

it("includes project documents only within the fixed Task root", async () => {
  const query = vi.fn(async () => [{ canvas_id: "canvas" }]);
  const persistence = {
    forInstance: () => ({ query }),
  } as unknown as PersistenceService;
  const root = await mkdtemp(join(tmpdir(), "design-layout-"));
  const layout = join(root, ".kenfutwork/canvases/canvas.json");
  await mkdir(join(root, ".kenfutwork/canvases"), { recursive: true });
  await writeFile(layout, "{}\n");
  const scope = {
    preset: "code",
    branchGeneration: 3,
    describe: () => ({
      instanceId: "instance",
      projectId: "project",
      taskId: "task",
      generation: 2,
      rootDirectory: root,
    }),
    resolvePath: vi.fn(async (path: string) => join(root, path)),
  } as unknown as ExecutionScopeHandle;
  try {
    await expect(
      createProjectLayoutFiles(persistence)(scope, {
        instanceId: "instance",
        accessClientId: "client",
      }),
    ).resolves.toEqual([".kenfutwork/canvases/canvas.json"]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("c.deleted_at is null and c.root_directory=$5"),
      ["task", "project", 2, 3, root],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
