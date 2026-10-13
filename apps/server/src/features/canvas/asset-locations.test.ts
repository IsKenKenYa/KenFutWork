import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { fingerprintOf } from "../project-files/filesystem.js";
import type { ProjectFileLocation } from "../project-files/types.js";
import { createCanvasAssetLocations } from "./asset-locations.js";
import { canvasContentPath, createCanvasFileStore } from "./file-store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(maximum = 256 * 1024 * 1024) {
  const root = await mkdtemp(join(tmpdir(), "canvas-export-"));
  roots.push(root);
  const actor = { instanceId: randomUUID(), accessClientId: randomUUID() };
  const projectId = randomUUID(),
    canvasId = randomUUID(),
    assetId = randomUUID();
  const bytes = Buffer.from([0, 255, 37, 0, 19]);
  const version = fingerprintOf(bytes);
  let currentPath = "image.png";
  await writeFile(join(root, "image.png"), bytes);
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
        storageRef: `oss://project-assets/${actor.instanceId}/project-files/${assetId}`,
      },
    },
  };
  const store = createCanvasFileStore({ projectRoot: root });
  const snapshot = await store.save(canvasId, content, null);
  const inspect = vi.fn(
    async (): Promise<ProjectFileLocation> => ({
      assetId,
      version,
      relativePath: currentPath,
      projectId,
      taskId: null,
      canvasId: null,
      bucket: "project-assets" as const,
      objectPath: `${actor.instanceId}/project-files/${assetId}`,
    }),
  );
  const move = vi.fn(
    async (
      _actor: unknown,
      _assetId: string,
      nextPath: string,
      expected?: { expectedRelativePath: string; expectedVersion: string },
    ) => {
      if (
        !expected ||
        currentPath !== expected.expectedRelativePath ||
        expected.expectedVersion !== version ||
        fingerprintOf(await readFile(join(root, currentPath))) !== version
      )
        throw Object.assign(new Error("素材已改变"), { code: "file_conflict" });
      await mkdir(dirname(join(root, nextPath)), { recursive: true });
      await rename(join(root, currentPath), join(root, nextPath));
      currentPath = nextPath;
      return {
        assetId,
        version,
        relativePath: currentPath,
        bucket: "project-assets" as const,
        objectPath: `${actor.instanceId}/project-files/${assetId}`,
      };
    },
  );
  const read = vi.fn(async () => readFile(join(root, "image.png")));
  const restoreIndex = vi.fn(async () => [{ assetId }]);
  const deps = {
    canvases: {
      claimRoot: async () => root,
      findById: async () => ({
        id: canvasId,
        project_id: projectId,
        content: { old: true },
        name: "canvas",
      }),
    },
    localInstance: {
      resolve: async () => ({ instanceId: actor.instanceId, dataDir: root }),
    },
    projects: { getProject: async () => ({ kind: "design", work_dir: root }) },
    projectFiles: { inspect, read, restoreIndex, move },
    exportMaxBytes: async () => maximum,
  } as unknown as Parameters<typeof createCanvasAssetLocations>[0];
  return {
    root,
    actor,
    canvasId,
    assetId,
    projectId,
    bytes,
    version,
    content,
    snapshot,
    store,
    inspect,
    move,
    read,
    restoreIndex,
    service: createCanvasAssetLocations(deps),
  };
}
it("exports standalone tar with actual binary bytes and relative layout references", async () => {
  const f = await fixture();
  const result = await f.service.export(
    f.actor,
    f.canvasId,
    f.snapshot.revision,
  );
  const path = join(f.root, "export.tar");
  await writeFile(path, result.bytes);
  const extracted = join(f.root, "extracted");
  await mkdir(extracted);
  await promisify(execFile)("tar", ["-xf", path, "-C", extracted]);
  const layout = JSON.parse(
    await readFile(join(extracted, "layout.json"), "utf8"),
  );
  const relativePath = `assets/${f.assetId}.png`;
  expect(layout.files.image.relativePath).toBe(relativePath);
  expect(layout.files.image.dataURL).toBe(relativePath);
  expect(layout.files.image.storageRef).toBeUndefined();
  expect(layout.files.image.version).toBe(f.version);
  expect(layout.elements).toEqual(f.content.elements);
  expect(await readFile(join(extracted, relativePath))).toEqual(f.bytes);
  expect((await f.store.read(f.canvasId))?.revision).toBe(f.snapshot.revision);
});
it("export rejects absent or externally changed bytes without substituting remote content", async () => {
  const f = await fixture();
  await rm(join(f.root, "image.png"));
  await expect(
    f.service.export(f.actor, f.canvasId, f.snapshot.revision),
  ).rejects.toThrow();
  await writeFile(join(f.root, "image.png"), "external-change");
  await expect(
    f.service.export(f.actor, f.canvasId, f.snapshot.revision),
  ).rejects.toMatchObject({ code: "file_conflict" });
});
it("raw-layout restoration passes only exact layout references and version to atomic index consumer", async () => {
  const f = await fixture();
  await rm(join(f.root, "image.png"));
  const result = await f.service.restoreReferences(
    f.actor,
    f.canvasId,
    f.snapshot.revision,
  );
  expect(f.inspect).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.restoreIndex.mock.calls[0]?.slice(0, 3)).toEqual([
    f.actor,
    f.projectId,
    [{ assetId: f.assetId, relativePath: "image.png", version: f.version }],
  ]);
  expect(result.assetIds).toEqual([f.assetId]);
});
it("revision change during byte read rejects export and does not modify current layout", async () => {
  const f = await fixture();
  f.read.mockImplementationOnce(async () => {
    await f.store.save(
      f.canvasId,
      { ...f.content, appState: { scrollX: 99 } },
      f.snapshot.revision,
    );
    return f.bytes;
  });
  await expect(
    f.service.export(f.actor, f.canvasId, f.snapshot.revision),
  ).rejects.toMatchObject({ code: "file_conflict" });
  expect((await f.store.read(f.canvasId))?.content.appState.scrollX).toBe(99);
});
it("unknown material identity fails before any filesystem enumeration or byte lookup", async () => {
  const f = await fixture();
  const stored = await f.store.save(
    f.canvasId,
    {
      ...f.content,
      files: { unknown: { dataURL: "https://example.test/file.png" } },
    },
    f.snapshot.revision,
  );
  await expect(
    f.service.export(f.actor, f.canvasId, stored.revision),
  ).rejects.toMatchObject({ code: "file_missing" });
  expect(f.read).not.toHaveBeenCalled();
  expect(f.inspect).not.toHaveBeenCalled();
});

it("moves an image and updates only its canonical file path", async () => {
  const f = await fixture();
  const result = await f.service.move(f.actor, f.canvasId, f.assetId, {
    relativePath: "renamed/image.png",
    expectedRelativePath: "image.png",
    expectedVersion: f.version,
    expectedRevision: f.snapshot.revision,
  });

  const saved = await f.store.read(f.canvasId);
  expect(result.relativePath).toBe("renamed/image.png");
  expect(saved?.content.files.image).toMatchObject({
    relativePath: "renamed/image.png",
    version: f.version,
    storageRef: `oss://project-assets/${f.actor.instanceId}/project-files/${f.assetId}`,
  });
  expect(await readFile(join(f.root, "renamed/image.png"))).toEqual(f.bytes);
  expect(f.move).toHaveBeenCalledTimes(1);
});

it("moves a video and updates only its canonical custom-data path", async () => {
  const f = await fixture();
  const videoContent = {
    ...f.content,
    elements: [
      {
        id: "video",
        type: "video",
        link: `oss://project-assets/${f.actor.instanceId}/project-files/${f.assetId}`,
        customData: {
          isVideo: true,
          assetId: f.assetId,
          relativePath: "image.png",
          version: f.version,
        },
      },
    ],
    files: {},
  };
  const snapshot = await f.store.save(
    f.canvasId,
    videoContent,
    f.snapshot.revision,
  );

  await f.service.move(f.actor, f.canvasId, f.assetId, {
    relativePath: "video/clip.mp4",
    expectedRelativePath: "image.png",
    expectedVersion: f.version,
    expectedRevision: snapshot.revision,
  });

  expect((await f.store.read(f.canvasId))?.content.elements[0]).toMatchObject({
    link: videoContent.elements[0]?.link,
    customData: {
      isVideo: true,
      assetId: f.assetId,
      relativePath: "video/clip.mp4",
      version: f.version,
    },
  });
  expect(await readFile(join(f.root, "video/clip.mp4"))).toEqual(f.bytes);
});

it("rejects stale layout revisions before moving the asset", async () => {
  const f = await fixture();
  await f.store.save(
    f.canvasId,
    { ...f.content, appState: { changed: true } },
    f.snapshot.revision,
  );

  await expect(
    f.service.move(f.actor, f.canvasId, f.assetId, {
      relativePath: "new.png",
      expectedRelativePath: "image.png",
      expectedVersion: f.version,
      expectedRevision: f.snapshot.revision,
    }),
  ).rejects.toMatchObject({ code: "file_conflict" });
  expect(f.move).not.toHaveBeenCalled();
  expect(f.inspect).not.toHaveBeenCalled();
  expect(await readFile(join(f.root, "image.png"))).toEqual(f.bytes);
});

it.each([
  ["asset path", { relativePath: "elsewhere.png" }],
  ["project", { projectId: randomUUID() }],
  ["canvas", { canvasId: randomUUID() }],
] as const)("rejects a move with a mismatched %s", async (mismatch, change) => {
  const f = await fixture();
  f.inspect.mockImplementationOnce(async () => ({
    assetId: f.assetId,
    version: f.version,
    relativePath: "relativePath" in change ? change.relativePath : "image.png",
    projectId: "projectId" in change ? change.projectId : f.projectId,
    taskId: null,
    canvasId: "canvasId" in change ? change.canvasId : null,
    bucket: "project-assets" as const,
    objectPath: `${f.actor.instanceId}/project-files/${f.assetId}`,
  }));

  await expect(
    f.service.move(f.actor, f.canvasId, f.assetId, {
      relativePath: "new.png",
      expectedRelativePath: "image.png",
      expectedVersion: f.version,
      expectedRevision: f.snapshot.revision,
    }),
  ).rejects.toMatchObject({ code: "file_conflict" });
  expect(f.move, `${mismatch} mismatch must not move`).not.toHaveBeenCalled();
  expect(await readFile(join(f.root, "image.png"))).toEqual(f.bytes);
});

it("compensates the file move when an external layout change wins publication", async () => {
  const f = await fixture();
  const originalMove = f.move.getMockImplementation()!;
  f.move.mockImplementationOnce(async (...args) => {
    const moved = await originalMove(...args);
    await writeFile(
      canvasContentPath(f.root, f.canvasId),
      JSON.stringify({ ...f.content, appState: { external: true } }),
    );
    return moved;
  });

  await expect(
    f.service.move(f.actor, f.canvasId, f.assetId, {
      relativePath: "new.png",
      expectedRelativePath: "image.png",
      expectedVersion: f.version,
      expectedRevision: f.snapshot.revision,
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });

  expect(f.move).toHaveBeenCalledTimes(2);
  expect(f.move.mock.calls.map((call) => call.slice(1))).toEqual([
    [
      f.assetId,
      "new.png",
      {
        expectedRelativePath: "image.png",
        expectedVersion: f.version,
      },
    ],
    [
      f.assetId,
      "image.png",
      {
        expectedRelativePath: "new.png",
        expectedVersion: f.version,
      },
    ],
  ]);
  expect(await readFile(join(f.root, "image.png"))).toEqual(f.bytes);
  await expect(readFile(join(f.root, "new.png"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    JSON.parse(await readFile(canvasContentPath(f.root, f.canvasId), "utf8")),
  ).toEqual({ ...f.content, appState: { external: true } });
});

it("preserves externally changed move bytes and reports repair when compensation is unsafe", async () => {
  const f = await fixture();
  const externalBytes = Buffer.from("external writer owns this file");
  const originalMove = f.move.getMockImplementation()!;
  f.move.mockImplementationOnce(async (...args) => {
    const moved = await originalMove(...args);
    await writeFile(join(f.root, "new.png"), externalBytes);
    await writeFile(
      canvasContentPath(f.root, f.canvasId),
      JSON.stringify({ ...f.content, appState: { external: true } }),
    );
    return moved;
  });

  await expect(
    f.service.move(f.actor, f.canvasId, f.assetId, {
      relativePath: "new.png",
      expectedRelativePath: "image.png",
      expectedVersion: f.version,
      expectedRevision: f.snapshot.revision,
    }),
  ).rejects.toMatchObject({
    code: "file_repair_required",
    message: expect.stringContaining("new.png"),
  });

  expect(f.move).toHaveBeenCalledTimes(2);
  expect(await readFile(join(f.root, "new.png"))).toEqual(externalBytes);
  await expect(readFile(join(f.root, "image.png"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("rejects a late save using the original revision after the move", async () => {
  const f = await fixture();
  await f.service.move(f.actor, f.canvasId, f.assetId, {
    relativePath: "new.png",
    expectedRelativePath: "image.png",
    expectedVersion: f.version,
    expectedRevision: f.snapshot.revision,
  });
  const afterMove = await f.store.read(f.canvasId);

  await expect(
    f.store.save(f.canvasId, f.content, f.snapshot.revision),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(
    (await f.store.read(f.canvasId))?.content.files.image?.relativePath,
  ).toBe("new.png");
  expect(afterMove?.content.files.image?.relativePath).toBe("new.png");
});

it("publishes real Canvas CAS references for a committed move even when the source copy remains", async () => {
  const f = await fixture();
  const originalMove = f.move.getMockImplementation()!;
  f.move.mockImplementationOnce(async (...args) => {
    const committed = await originalMove(...args);
    // 已提交move的Provider返回新位置；清理旧副本失败不改变该receipt。
    await writeFile(join(f.root, "image.png"), f.bytes);
    return committed;
  });
  const result = await f.service.move(f.actor, f.canvasId, f.assetId, {
    relativePath: "assets/moved.png",
    expectedRelativePath: "image.png",
    expectedVersion: f.version,
    expectedRevision: f.snapshot.revision,
  });
  expect(result.relativePath).toBe("assets/moved.png");
  const layout = await f.store.read(f.canvasId);
  expect(layout?.revision).not.toBe(f.snapshot.revision);
  expect(layout?.content.files.image).toMatchObject({
    assetId: f.assetId,
    relativePath: "assets/moved.png",
    version: f.version,
  });
  expect(await readFile(join(f.root, "image.png"))).toEqual(f.bytes);
  expect(await readFile(join(f.root, "assets/moved.png"))).toEqual(f.bytes);
  expect(f.move).toHaveBeenCalledTimes(1);
  await expect(
    f.store.save(f.canvasId, f.content, f.snapshot.revision),
  ).rejects.toMatchObject({
    code: "revision_conflict",
  });
});

it("export checks the configured tar budget before reading and includes headers and padding", async () => {
  const belowHeader = await fixture(1024);
  await expect(
    belowHeader.service.export(
      belowHeader.actor,
      belowHeader.canvasId,
      belowHeader.snapshot.revision,
    ),
  ).rejects.toMatchObject({ statusCode: 413 });
  expect(belowHeader.read).not.toHaveBeenCalled();
  const limited = await fixture(2048);
  await expect(
    limited.service.export(
      limited.actor,
      limited.canvasId,
      limited.snapshot.revision,
    ),
  ).rejects.toMatchObject({ statusCode: 413 });
  expect(limited.read).toHaveBeenCalledWith(limited.actor, limited.assetId, {
    maxBytes: 512,
  });
  expect((await limited.store.read(limited.canvasId))?.revision).toBe(
    limited.snapshot.revision,
  );
  const expanded = await fixture(4096);
  const result = await expanded.service.export(
    expanded.actor,
    expanded.canvasId,
    expanded.snapshot.revision,
  );
  expect(result.bytes.byteLength).toBeLessThanOrEqual(4096);
});
