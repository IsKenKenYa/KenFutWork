import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { PersistenceService } from "../persistence/types.js";
import { createDesignLayoutFiles } from "./design-layout-files.js";

it("returns only the bound Design Task canvas layout", async () => {
  const query = vi.fn(async () => [{ canvas_id: "canvas" }]);
  const persistence = {
    forInstance: () => ({ query }),
  } as unknown as PersistenceService;
  const root = await mkdtemp(join(tmpdir(), "design-layout-"));
  const layout = join(root, ".kenfutwork/canvases/canvas.json");
  await mkdir(join(root, ".kenfutwork/canvases"), { recursive: true });
  await writeFile(layout, "{}\n");
  const scope = {
    preset: "design",
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
      createDesignLayoutFiles(persistence)(scope, {
        instanceId: "instance",
        accessClientId: "client",
      }),
    ).resolves.toEqual([".kenfutwork/canvases/canvas.json"]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("task_kind='design'"),
      ["task", "project", 2, 3],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
