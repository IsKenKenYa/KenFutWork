import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalInstanceService } from "../local-instance/service.js";
import { createCanvasService } from "./canvas-service.js";
import type { CanvasRepository, CanvasRow } from "./repository.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-document-"));
  roots.push(root);
  const rows = new Map<string, CanvasRow>();
  const actor = { instanceId: "instance", accessClientId: "client" };
  const repository: CanvasRepository = {
    notificationTarget: async (id) => {
      const row = rows.get(id);
      return row
        ? {
            instance_id: actor.instanceId,
            project_id: row.project_id,
            deleted_at: row.deleted_at ?? null,
          }
        : null;
    },
    notifyChanged: vi.fn(async () => {}),
    withDocumentLock: async (_instance, _id, operation) =>
      operation(new AbortController().signal),
    list: async (_instance, projectId, query) =>
      [...rows.values()].filter(
        (row) =>
          row.project_id === projectId &&
          !row.deleted_at &&
          (!query || row.name.toLowerCase().includes(query.toLowerCase())),
      ),
    create: async (input) => {
      const previous = rows.get(input.canvasId);
      if (previous)
        return !previous.deleted_at &&
          previous.project_id === input.projectId &&
          previous.name === input.name
          ? previous
          : null;
      const row = {
        id: input.canvasId,
        project_id: input.projectId,
        name: input.name,
        root_directory: root,
        is_primary: rows.size === 0,
        content: { elements: [], appState: {}, files: {} },
      };
      rows.set(row.id, row);
      return row;
    },
    rename: async (instanceId, id, expected, name) => {
      const row = rows.get(id);
      if (
        instanceId !== actor.instanceId ||
        !row ||
        row.deleted_at ||
        row.name !== expected
      )
        return 0;
      row.name = name;
      return 1;
    },
    remove: async (instanceId, id) => {
      const row = rows.get(id);
      if (instanceId !== actor.instanceId || !row || row.deleted_at) return 0;
      row.deleted_at = "deleted";
      row.is_primary = false;
      return 1;
    },
    claimRoot: async () => root,
    findById: async (instanceId, id, options) => {
      const row = rows.get(id);
      return instanceId === actor.instanceId &&
        row &&
        (!row.deleted_at || options?.includeDeleted)
        ? structuredClone(row)
        : null;
    },
    findProjectBrandKitId: async () => null,
    recordFileIndex: async (_instance, id) => {
      const row = rows.get(id);
      if (!row || row.deleted_at) return 0;
      row.content = { storage: "project-files" };
      return 1;
    },
  };
  const service = createCanvasService({
    repository,
    localInstance: createLocalInstanceService({
      repository: { ensure: async () => actor.instanceId },
      dataDir: root,
    }),
    projects: {
      getProject: async () => ({
        id: "project",
        enabled_modes: ["code", "design"],
        work_dir: root,
      }),
    } as never,
    blob: {} as never,
    projectFiles: {} as never,
  });
  return { service, actor, repository, rows, root };
}

it("项目文档显式创建，按同请求重放与名称字面搜索，不创建会话", async () => {
  const f = await fixture();
  expect(await f.service.listCanvases(f.actor, "project")).toEqual([]);
  const input = { requestId: randomUUID(), name: "海报 100%" };
  const first = await f.service.createCanvas(f.actor, "project", input);
  const replay = await f.service.createCanvas(f.actor, "project", input);
  expect(first.id).toBe(input.requestId);
  expect(replay.id).toBe(first.id);
  expect(await f.service.listCanvases(f.actor, "project", "%")).toEqual([
    { id: first.id, name: input.name, isPrimary: true },
  ]);
  expect(await f.service.listCanvases(f.actor, "project", "missing")).toEqual(
    [],
  );
  expect(first.content).toEqual({ elements: [], appState: {}, files: {} });
});

it("改名核对名称和文件版本，过期改名或删除不会覆盖新成果", async () => {
  const f = await fixture();
  const first = await f.service.createCanvas(f.actor, "project", {
    name: "原名",
  });
  const renamed = await f.service.renameCanvas(f.actor, first.id, {
    name: "新名",
    expectedName: "原名",
    expectedRevision: first.revision,
  });
  expect(renamed.name).toBe("新名");
  await expect(
    f.service.renameCanvas(f.actor, first.id, {
      name: "迟到名称",
      expectedName: "原名",
      expectedRevision: first.revision,
    }),
  ).rejects.toThrow("名称已改变");
  const saved = await f.service.saveCanvasContent(
    f.actor,
    first.id,
    { elements: [{ id: "latest" }], appState: {}, files: {} },
    first.revision,
  );
  await expect(
    f.service.deleteCanvas(f.actor, first.id, first.revision),
  ).rejects.toThrow("已改变");
  expect((await f.service.getCanvas(f.actor, first.id)).revision).toBe(
    saved.revision,
  );
});

it("删除只移除活跃文档索引，保留源文件并阻止迟到保存或同ID创建", async () => {
  const f = await fixture();
  const requestId = randomUUID();
  const first = await f.service.createCanvas(f.actor, "project", {
    name: "文档",
    requestId,
  });
  const path = join(f.root, ".kenfutwork", "canvases", `${first.id}.json`);
  const original = await readFile(path);
  await f.service.deleteCanvas(f.actor, first.id, first.revision);
  expect(await f.service.listCanvases(f.actor, "project")).toEqual([]);
  expect(await readFile(path)).toEqual(original);
  expect(f.rows.get(first.id)?.is_primary).toBe(false);
  await expect(
    f.service.saveCanvasContent(
      f.actor,
      first.id,
      { elements: [{ id: "late" }], appState: {}, files: {} },
      first.revision,
    ),
  ).rejects.toThrow("已删除");
  await expect(
    f.service.createCanvas(f.actor, "project", { name: "文档", requestId }),
  ).rejects.toThrow("请求已失效");
  expect(await readFile(path)).toEqual(original);
});

it("其他实例不能借用文档ID进行条件删除", async () => {
  const f = await fixture();
  const first = await f.service.createCanvas(f.actor, "project", {
    name: "文档",
  });
  await expect(
    f.service.deleteCanvas(
      { ...f.actor, instanceId: "other" },
      first.id,
      first.revision,
    ),
  ).rejects.toThrow();
  expect((await f.service.getCanvas(f.actor, first.id)).name).toBe("文档");
});

it("文档真实变化才广播，重放创建、同版本保存、GET和失败修改不形成通知回环", async () => {
  const f = await fixture();
  const input = { name: "文档", requestId: randomUUID() };
  const first = await f.service.createCanvas(f.actor, "project", input);
  await f.service.createCanvas(f.actor, "project", input);
  await f.service.getCanvas(f.actor, first.id);
  await f.service.saveCanvasContent(
    f.actor,
    first.id,
    first.content,
    first.revision,
  );
  expect(f.repository.notifyChanged).toHaveBeenCalledTimes(1);
  const saved = await f.service.saveCanvasContent(
    f.actor,
    first.id,
    { elements: [{ id: "actual-update" }], appState: {}, files: {} },
    first.revision,
  );
  expect(f.repository.notifyChanged).toHaveBeenCalledTimes(2);
  await f.service.renameCanvas(f.actor, first.id, {
    name: "改名",
    expectedName: "文档",
    expectedRevision: saved.revision,
  });
  expect(f.repository.notifyChanged).toHaveBeenCalledTimes(3);
  await expect(
    f.service.deleteCanvas(f.actor, first.id, first.revision),
  ).rejects.toThrow("已改变");
  expect(f.repository.notifyChanged).toHaveBeenCalledTimes(3);
  await f.service.deleteCanvas(f.actor, first.id, saved.revision);
  expect(f.repository.notifyChanged).toHaveBeenCalledTimes(4);
  expect(f.repository.notifyChanged).toHaveBeenLastCalledWith(
    f.actor.instanceId,
    first.id,
  );
});
