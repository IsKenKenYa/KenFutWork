import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createCanvasAssetLocations } from "../features/canvas/asset-locations.js";
import {
  canvasContentPath,
  createCanvasFileStore,
} from "../features/canvas/file-store.js";
import type { CanvasRepository } from "../features/canvas/repository.js";
import { createLocalAccessFixture } from "../features/local-access/test-fixture.js";
import type { LocalActor } from "../features/local-instance/types.js";
import { fingerprintOf } from "../features/project-files/filesystem.js";
import { createProjectFileService } from "../features/project-files/service.js";
import {
  ProjectFileError,
  type ProjectFileRecord,
  type ProjectFileRelink,
  type ProjectFileRepository,
} from "../features/project-files/types.js";
import type { ProjectDetailRow } from "../features/projects/repository.js";
import { registerProjectFileRoutes } from "./project-files.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** Same indexed repository seam as project-files/service.test; filesystem operations remain production code. */
function repository(
  rows: Map<string, ProjectFileRecord>,
): ProjectFileRepository {
  const current = (instanceId: string, assetId: string) => {
    const row = rows.get(assetId);
    if (!row || row.instance_id !== instanceId)
      throw new Error("索引归属不存在");
    return row;
  };
  const check = (row: ProjectFileRecord, input: ProjectFileRelink) => {
    if (
      row.relative_path !== input.expectedRelativePath ||
      row.write_fingerprint !== input.expectedVersion
    )
      throw new Error("索引版本冲突");
  };
  const link = (row: ProjectFileRecord, input: ProjectFileRelink) => {
    row.relative_path = input.relativePath;
    row.write_fingerprint = input.fileVersion;
    if (input.canvasId !== undefined) row.canvas_id = input.canvasId;
  };
  return {
    find: async (instance, id) =>
      rows.get(id)?.instance_id === instance
        ? structuredClone(rows.get(id)!)
        : null,
    prepare: async (record) => {
      if (!rows.has(record.id))
        rows.set(record.id, { ...structuredClone(record), byte_size: null });
      return structuredClone(current(record.instance_id, record.id));
    },
    complete: async (instance, id, version, byteSize) => {
      const row = current(instance, id);
      if (row.write_fingerprint !== version) throw new Error("发布版本冲突");
      row.file_state = "ready";
      row.byte_size = byteSize;
    },
    beginMove: async (instance, id, previous, next) => {
      const row = current(instance, id);
      if (row.relative_path !== previous || row.pending_relative_path)
        throw new Error("移动索引冲突");
      row.pending_relative_path = next;
    },
    finishMove: async (instance, id, previous, next) => {
      const row = current(instance, id);
      if (row.relative_path !== previous || row.pending_relative_path !== next)
        throw new Error("移动发布冲突");
      row.relative_path = next;
      row.pending_relative_path = null;
    },
    relink: async (instance, id, input, byteSize) => {
      const row = current(instance, id);
      check(row, input);
      link(row, input);
      row.byte_size = byteSize;
    },
    relinkBatch: async (instance, entries) => {
      for (const entry of entries)
        check(current(instance, entry.assetId), entry.input);
      for (const entry of entries) {
        const row = current(instance, entry.assetId);
        link(row, entry.input);
        row.byte_size = entry.byteSize;
      }
    },
  };
}

async function fixture(
  exportLimit = 256 * 1024 * 1024,
  bytes = Buffer.from([0, 255, 37, 0, 19]),
) {
  const access = await createLocalAccessFixture();
  const app = Fastify();
  cleanup.push(async () => {
    await app.close();
    await access.cleanup();
  });
  const actor = await access.service.authenticate(access.request);
  if (!actor) throw new Error("真实本机接入未初始化");
  const rootPath = join(access.dataDir, "project");
  await mkdir(rootPath);
  const root = await realpath(rootPath);
  const projectId = randomUUID(),
    canvasId = randomUUID(),
    assetId = randomUUID();
  const project: ProjectDetailRow = {
    id: projectId,
    instance_id: actor.instanceId,
    kind: "design",
    enabled_modes: ["design"],
    name: "HTTP files",
    slug: "http-files",
    description: null,
    brand_kit_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    work_dir: root,
    additional_directories: [],
  };
  const projects = {
    getProject: async (owner: LocalActor, id: string) => {
      if (owner.instanceId !== actor.instanceId || id !== projectId)
        throw new ProjectFileError("not_found", "项目不存在", 404);
      return project;
    },
  };
  const canvases: Pick<CanvasRepository, "findById" | "claimRoot"> = {
    findById: async (instance, id) =>
      instance === actor.instanceId && id === canvasId
        ? {
            id,
            name: "HTTP Canvas",
            project_id: projectId,
            content: null,
            root_directory: root,
          }
        : null,
    claimRoot: async (instance, id, resolveDefault) => {
      if (instance !== actor.instanceId || id !== canvasId)
        throw new ProjectFileError("not_found", "画布不存在", 404);
      return resolveDefault(root);
    },
  };
  const rows = new Map<string, ProjectFileRecord>();
  const repo = repository(rows);
  const files = createProjectFileService({
    repository: repo,
    projects,
    canvases,
    localInstance: access.options.instance,
    executionScopes: {
      openTask: async () => {
        throw new Error("此HTTP fixture不创建Task执行权限");
      },
    },
  });
  const version = fingerprintOf(bytes);
  const receipt = await files.publish(
    actor,
    {
      assetId,
      target: { kind: "canvas", projectId, canvasId },
      relativePath: "image.png",
      mimeType: "image/png",
      writeFingerprint: version,
    },
    bytes,
  );
  const content = {
    elements: [{ id: "element", type: "image", fileId: "image" }],
    appState: { scrollX: 42 },
    files: {
      image: {
        id: "image",
        assetId,
        relativePath: "image.png",
        version,
        mimeType: "image/png",
        storageRef: `oss://project-assets/${receipt.objectPath}`,
      },
    },
  };
  const store = createCanvasFileStore({ projectRoot: root });
  const snapshot = await store.save(canvasId, content, null);
  const canvasAssets = createCanvasAssetLocations({
    canvases,
    projects,
    localInstance: access.options.instance,
    projectFiles: files,
    exportMaxBytes: async () => exportLimit,
  });
  await registerProjectFileRoutes(app, {
    localAccess: access.service,
    projectFiles: files,
    canvasAssets,
  });
  const headers = { authorization: `Bearer ${access.token}` };
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url,
      payload,
      headers,
      remoteAddress: "127.0.0.1",
    });
  const move = {
    relativePath: "moved/image.png",
    expectedRelativePath: "image.png",
    expectedVersion: version,
    expectedRevision: snapshot.revision,
  };
  return {
    app,
    access,
    actor,
    root,
    rows,
    repo,
    bytes,
    version,
    projectId,
    canvasId,
    assetId,
    store,
    content,
    snapshot,
    headers,
    post,
    move,
  };
}

it("HTTP uses real LocalAccess admission and owned indexed inspect", async () => {
  const f = await fixture();
  const url = `/api/project-files/${f.assetId}`;
  expect(
    (await f.app.inject({ url, remoteAddress: "127.0.0.1" })).statusCode,
  ).toBe(401);
  expect(
    (
      await f.app.inject({
        url,
        headers: { authorization: "Bearer invalid" },
        remoteAddress: "127.0.0.1",
      })
    ).statusCode,
  ).toBe(401);
  const response = await f.app.inject({
    url,
    headers: f.headers,
    remoteAddress: "127.0.0.1",
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    assetId: f.assetId,
    projectId: f.projectId,
    taskId: null,
    relativePath: "image.png",
    version: f.version,
    objectPath: `${f.actor.instanceId}/project-files/${f.assetId}`,
  });
  const foreign = randomUUID();
  const own = f.rows.get(f.assetId);
  if (!own) throw new Error("真实发布索引缺失");
  f.rows.set(foreign, { ...own, id: foreign, instance_id: randomUUID() });
  const denied = await f.app.inject({
    url: `/api/project-files/${foreign}`,
    headers: f.headers,
    remoteAddress: "127.0.0.1",
  });
  expect(denied.statusCode).toBe(404);
  expect(denied.json()).toMatchObject({ error: { code: "not_found" } });
});

it("HTTP stale asset version and Canvas revision preserve file, layout and index", async () => {
  const f = await fixture();
  const before = structuredClone([...f.rows]);
  const layout = await readFile(canvasContentPath(f.root, f.canvasId));
  const version = await f.post(`/api/project-files/${f.assetId}/move`, {
    relativePath: f.move.relativePath,
    expectedRelativePath: f.move.expectedRelativePath,
    expectedVersion: "0".repeat(64),
  });
  expect(version.statusCode).toBe(409);
  expect(version.json()).toMatchObject({ error: { code: "file_conflict" } });
  const revision = await f.post(
    `/api/canvases/${f.canvasId}/assets/${f.assetId}/move`,
    { ...f.move, expectedRevision: "0".repeat(64) },
  );
  expect(revision.statusCode).toBe(409);
  expect(revision.json()).toMatchObject({ error: { code: "file_conflict" } });
  expect(await readFile(join(f.root, "image.png"))).toEqual(f.bytes);
  await expect(
    readFile(join(f.root, f.move.relativePath)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(canvasContentPath(f.root, f.canvasId))).toEqual(layout);
  expect([...f.rows]).toEqual(before);
});

it("HTTP Canvas move publishes actual bytes and matching layout/index", async () => {
  const f = await fixture();
  const response = await f.post(
    `/api/canvases/${f.canvasId}/assets/${f.assetId}/move`,
    f.move,
  );
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    assetId: f.assetId,
    relativePath: f.move.relativePath,
    version: f.version,
  });
  await expect(readFile(join(f.root, "image.png"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(f.root, f.move.relativePath))).toEqual(f.bytes);
  const snapshot = await f.store.read(f.canvasId);
  expect(snapshot?.content.files.image).toMatchObject({
    assetId: f.assetId,
    relativePath: f.move.relativePath,
    version: f.version,
  });
  expect(snapshot?.revision).not.toBe(f.snapshot.revision);
  expect(f.rows.get(f.assetId)).toMatchObject({
    relative_path: f.move.relativePath,
    pending_relative_path: null,
    file_state: "ready",
  });
});

it("HTTP export has actual tar bytes and headers, with no layout/index mutation", async () => {
  const f = await fixture();
  const before = structuredClone([...f.rows]);
  const response = await f.post(`/api/canvases/${f.canvasId}/export`, {
    expectedRevision: f.snapshot.revision,
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("application/x-tar");
  expect(response.headers["content-disposition"]).toBe(
    `attachment; filename="${f.canvasId}.tar"`,
  );
  expect(response.headers.etag).toBe(f.snapshot.revision);
  const archive = join(f.root, "export.tar"),
    extracted = join(f.root, "extracted");
  await writeFile(archive, response.rawPayload);
  await mkdir(extracted);
  await promisify(execFile)("tar", ["-xf", archive, "-C", extracted]);
  const layout = JSON.parse(
    await readFile(join(extracted, "layout.json"), "utf8"),
  );
  const relativePath = `assets/${f.assetId}.png`;
  expect(layout.files.image).toMatchObject({
    assetId: f.assetId,
    relativePath,
    dataURL: relativePath,
    version: f.version,
  });
  expect(layout.files.image.storageRef).toBeUndefined();
  expect(await readFile(join(extracted, relativePath))).toEqual(f.bytes);
  expect((await f.store.read(f.canvasId))?.revision).toBe(f.snapshot.revision);
  expect([...f.rows]).toEqual(before);
});

it("HTTP restore rejects externally changed file version without publishing indexes", async () => {
  const f = await fixture();
  const before = structuredClone([...f.rows]);
  const changed = Buffer.from("externally changed asset");
  await writeFile(join(f.root, "image.png"), changed);
  const index = vi.spyOn(f.repo, "relinkBatch");
  const response = await f.post(`/api/canvases/${f.canvasId}/restore-assets`, {
    expectedRevision: f.snapshot.revision,
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ error: { code: "file_conflict" } });
  expect(index).not.toHaveBeenCalled();
  expect([...f.rows]).toEqual(before);
  expect(await readFile(join(f.root, "image.png"))).toEqual(changed);
  expect((await f.store.read(f.canvasId))?.revision).toBe(f.snapshot.revision);
});

it.each([
  { path: "../escape.png", status: 400, code: "invalid_path" },
  { path: "missing.png", status: 409, code: "file_missing" },
])(
  "HTTP restore refuses exact invalid/missing path $path without touching files/index",
  async ({ path, status, code }) => {
    const f = await fixture();
    const current = await f.store.save(
      f.canvasId,
      {
        ...f.content,
        files: { image: { ...f.content.files.image, relativePath: path } },
      },
      f.snapshot.revision,
    );
    const before = structuredClone([...f.rows]);
    const layout = await readFile(canvasContentPath(f.root, f.canvasId));
    const index = vi.spyOn(f.repo, "relinkBatch");
    const response = await f.post(
      `/api/canvases/${f.canvasId}/restore-assets`,
      { expectedRevision: current.revision },
    );
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(index).not.toHaveBeenCalled();
    expect([...f.rows]).toEqual(before);
    expect(await readFile(join(f.root, "image.png"))).toEqual(f.bytes);
    expect(await readFile(canvasContentPath(f.root, f.canvasId))).toEqual(
      layout,
    );
  },
);

it("HTTP restore reconciles only the registered exact layout path", async () => {
  const f = await fixture();
  const row = f.rows.get(f.assetId);
  if (!row) throw new Error("真实发布索引缺失");
  row.relative_path = "stale-index.png";
  const response = await f.post(`/api/canvases/${f.canvasId}/restore-assets`, {
    expectedRevision: f.snapshot.revision,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    revision: f.snapshot.revision,
    assetIds: [f.assetId],
  });
  expect(f.rows.get(f.assetId)).toMatchObject({
    relative_path: "image.png",
    write_fingerprint: f.version,
    canvas_id: f.canvasId,
  });
  expect(await readFile(join(f.root, "image.png"))).toEqual(f.bytes);
  expect((await f.store.read(f.canvasId))?.revision).toBe(f.snapshot.revision);
});

it("HTTP export enforces the delegated tar budget with 413 and no publication", async () => {
  const f = await fixture(1024 * 1024, Buffer.alloc(1024 * 1024, 7));
  expect(f.rows.get(f.assetId)?.byte_size).toBe(f.bytes.byteLength);
  const before = structuredClone([...f.rows]);
  const layout = await readFile(canvasContentPath(f.root, f.canvasId));
  const response = await f.post(`/api/canvases/${f.canvasId}/export`, {
    expectedRevision: f.snapshot.revision,
  });
  expect(response.statusCode).toBe(413);
  expect(response.json()).toMatchObject({ error: { code: "file_conflict" } });
  expect(response.headers["content-type"]).toContain("application/json");
  expect(response.headers["content-disposition"]).toBeUndefined();
  expect([...f.rows]).toEqual(before);
  expect(await readFile(canvasContentPath(f.root, f.canvasId))).toEqual(layout);
  expect(await readFile(join(f.root, "image.png"))).toEqual(f.bytes);
});
