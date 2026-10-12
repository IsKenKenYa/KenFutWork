import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canvasContentPath, createCanvasFileStore } from "./file-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(beforePublish?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "canvas-store-"));
  roots.push(root);
  return {
    root,
    store: createCanvasFileStore({
      projectRoot: root,
      ...(beforePublish ? { beforePublish } : {}),
    }),
  };
}
const content = {
  elements: [],
  appState: { viewBackgroundColor: "#fff" },
  files: {},
};

it("appendLatest并发不丢元素，同内容同ID重放幂等而冲突ID拒绝", async () => {
  const { store } = await fixture();
  await store.save("canvas", content, null);
  await Promise.all([
    store.appendLatest("canvas", { elements: [{ id: "a", x: 1 }] }),
    store.appendLatest("canvas", { elements: [{ id: "b", x: 2 }] }),
  ]);
  const current = (await store.read("canvas"))!;
  const replay = await store.appendLatest("canvas", {
    elements: [{ x: 1, id: "a" }],
  });
  expect(replay).toEqual(current);
  expect(current.content.elements).toHaveLength(2);
  await expect(
    store.appendLatest("canvas", { elements: [{ id: "a", x: 3 }] }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it("update holds the canvas CAS through its operation and publishes afterward", async () => {
  const { store } = await fixture();
  const saved = await store.save("canvas", content, null);
  let operationStarted = () => {};
  let releaseOperation = () => {};
  const started = new Promise<void>((resolve) => {
    operationStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  const update = store.update(
    "canvas",
    { ...content, files: { image: { relativePath: "new.png" } } },
    saved.revision,
    async () => {
      operationStarted();
      await held;
    },
  );
  await started;

  const competingSave = store.save(
    "canvas",
    { ...content, appState: { late: true } },
    saved.revision,
  );
  expect((await store.read("canvas"))?.revision).toBe(saved.revision);
  releaseOperation();
  const updated = await update;
  await expect(competingSave).rejects.toMatchObject({
    code: "revision_conflict",
  });
  expect(updated.content.files.image).toEqual({ relativePath: "new.png" });
});

it("update rejects a stale revision before invoking its operation", async () => {
  const { store } = await fixture();
  const saved = await store.save("canvas", content, null);
  await store.save(
    "canvas",
    { ...content, appState: { changed: true } },
    saved.revision,
  );
  const beforePublish = vi.fn(async () => {});

  await expect(
    store.update("canvas", content, saved.revision, beforePublish),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(beforePublish).not.toHaveBeenCalled();
});

it("缺失只返回null，显式create原子写入固定路径且已有文件不可覆盖", async () => {
  const { root, store } = await fixture();
  expect(await store.read("canvas")).toBeNull();
  const saved = await store.save("canvas", content, null);
  const bytes = await readFile(canvasContentPath(root, "canvas"));
  expect(saved.revision).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(await store.read("canvas")).toEqual(saved);
  await expect(
    store.save("canvas", { ...content, elements: [{}] }, null),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(await readdir(join(root, ".kenfutwork", "canvases"))).toEqual([
    "canvas.json",
  ]);
});

it("原始字节变更即使JSON含义相同也使旧revision冲突", async () => {
  const { root, store } = await fixture();
  const saved = await store.save("canvas", content, null);
  await writeFile(
    canvasContentPath(root, "canvas"),
    JSON.stringify(content, null, 2),
  );
  await expect(
    store.save("canvas", content, saved.revision),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect((await store.read("canvas"))!.revision).not.toBe(saved.revision);
});

it("save和append跨provider共享同画布CAS，竞争同revision只能一个发布", async () => {
  const { root, store } = await fixture();
  const saved = await store.save("canvas", content, null);
  const other = createCanvasFileStore({ projectRoot: root });
  const results = await Promise.allSettled([
    store.save("canvas", { ...content, appState: { zoom: 2 } }, saved.revision),
    other.append("canvas", { elements: [{ id: "new" }] }, saved.revision),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    results.filter((result) => result.status === "rejected"),
  ).toMatchObject([{ reason: { statusCode: 409 } }]);
});

it("append保留appState和既有素材原值，并合并新元素与文件", async () => {
  const { store } = await fixture();
  const saved = await store.save(
    "canvas",
    { ...content, files: { old: { dataURL: "asset://original" } } },
    null,
  );
  const appended = await store.append(
    "canvas",
    { elements: [{ id: "new" }], files: { new: { dataURL: "asset://new" } } },
    saved.revision,
  );
  expect(appended.content).toEqual({
    ...content,
    elements: [{ id: "new" }],
    files: {
      old: { dataURL: "asset://original" },
      new: { dataURL: "asset://new" },
    },
  });
});

it("授权失效或外部删除后的迟到写不复活文件，临时文件清理", async () => {
  let allowed = true;
  const { root, store } = await fixture(async () => {
    if (!allowed) throw new Error("画布已删除");
  });
  const saved = await store.save("canvas", content, null);
  await rm(canvasContentPath(root, "canvas"));
  await expect(
    store.save("canvas", content, saved.revision),
  ).rejects.toMatchObject({ statusCode: 409 });
  allowed = false;
  await expect(store.save("canvas", content, null)).rejects.toThrow(
    "画布已删除",
  );
  expect(await store.read("canvas")).toBeNull();
  expect(await readdir(join(root, ".kenfutwork", "canvases"))).toEqual([]);
});

it("发布前授权检查期间外部改动不被覆盖", async () => {
  let external = false;
  const { root, store } = await fixture(async () => {
    if (external)
      await writeFile(
        canvasContentPath(root, "canvas"),
        JSON.stringify({ ...content, appState: { external: true } }),
      );
  });
  const saved = await store.save("canvas", content, null);
  external = true;
  await expect(
    store.save("canvas", content, saved.revision),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect((await store.read("canvas"))!.content.appState).toEqual({
    external: true,
  });
  expect(await readdir(join(root, ".kenfutwork", "canvases"))).toEqual([
    "canvas.json",
  ]);
});

it("路径逃逸、目录及目标符号链接均拒绝且不写入外部", async () => {
  const { root, store } = await fixture();
  const outside = await fixture();
  await expect(store.read("../escape")).rejects.toMatchObject({
    code: "invalid_path",
  });
  await symlink(outside.root, join(root, ".kenfutwork"));
  await expect(store.save("canvas", content, null)).rejects.toMatchObject({
    code: "invalid_path",
  });
  await rm(join(root, ".kenfutwork"));
  await store.save("canvas", content, null);
  await rm(canvasContentPath(root, "canvas"));
  await writeFile(join(outside.root, "external.json"), "{}");
  await symlink(
    join(outside.root, "external.json"),
    canvasContentPath(root, "canvas"),
  );
  await expect(store.read("canvas")).rejects.toMatchObject({
    code: "invalid_path",
  });
  expect(await readFile(join(outside.root, "external.json"), "utf8")).toBe(
    "{}",
  );
});

it.each(["create", "replace"] as const)(
  "%s returns the published layout when temporary-file cleanup is denied",
  async (mode) => {
    const { root, store } = await fixture();
    const previous =
      mode === "replace" ? await store.save("canvas", content, null) : null;
    const changed = { ...content, appState: { committed: mode } };
    vi.mocked(unlink).mockRejectedValueOnce(
      Object.assign(new Error("temporary file is locked"), { code: "EPERM" }),
    );
    const operation = store.save("canvas", changed, previous?.revision ?? null);
    await expect(operation).resolves.toMatchObject({ content: changed });
    const result = await operation;
    const published = await readFile(canvasContentPath(root, "canvas"));
    expect(result.revision).toBe(
      createHash("sha256").update(published).digest("hex"),
    );
    expect(await store.read("canvas")).toEqual(result);
    await expect(
      store.save("canvas", content, previous?.revision ?? null),
    ).rejects.toMatchObject({
      code: "revision_conflict",
    });
  },
);

it("retains the original prepublication rejection when temporary cleanup also fails", async () => {
  const { store } = await fixture();
  const saved = await store.save("canvas", content, null);
  const denied = new Error("Task permission changed before publication");
  vi.mocked(unlink).mockRejectedValueOnce(
    Object.assign(new Error("temporary file is locked"), { code: "EPERM" }),
  );
  await expect(
    store.update(
      "canvas",
      { ...content, appState: { denied: true } },
      saved.revision,
      async () => {
        throw denied;
      },
    ),
  ).rejects.toBe(denied);
  expect(await store.read("canvas")).toEqual(saved);
});
