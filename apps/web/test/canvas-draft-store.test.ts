import type { CanvasContent } from "@kenfutwork/shared";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CanvasDraftScope,
  createCanvasDraftStore,
} from "@/lib/canvas-draft-store";

const scope: CanvasDraftScope = {
  projectId: "project-a",
  canvasId: "canvas-a",
  clientId: "tab-a",
};
const document = { projectId: scope.projectId, canvasId: scope.canvasId };
const base: CanvasContent = {
  elements: [{ id: "rectangle", type: "rectangle", x: 0 }],
  appState: { viewBackgroundColor: "#fff", gridModeEnabled: false },
  files: {},
};

function draft(generation = 1) {
  return {
    generation,
    content: {
      elements: [
        { id: "rectangle", type: "rectangle", x: generation },
        { id: "image", type: "image", fileId: "local-image" },
      ],
      appState: {
        viewBackgroundColor: "#000",
        gridModeEnabled: true,
        scrollX: 20,
        selectedElementIds: { image: true },
      },
      files: {
        "local-image": {
          id: "local-image",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,unsaved-image-bytes",
          created: 1,
        },
      },
    },
    base: { revision: "revision-1", content: structuredClone(base) },
    submitted: { revision: "revision-1", sceneKey: "submitted-scene-a" },
  };
}

describe("canvas durable draft store", () => {
  let indexedDB: IDBFactory;
  let stores: Array<ReturnType<typeof createCanvasDraftStore>>;

  beforeEach(() => {
    indexedDB = new IDBFactory();
    stores = [];
  });

  afterEach(async () => {
    await Promise.all(stores.map((store) => store.close()));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function open() {
    const store = createCanvasDraftStore({
      indexedDB,
      databaseName: "canvas-draft-store-test",
    });
    stores.push(store);
    return store;
  }

  it("restores unsaved elements, media, confirmed base and in-flight fingerprint after closing and reopening", async () => {
    const first = open();
    const input = draft();
    const saved = await first.write(scope, input);
    expect(saved).toEqual({ ...scope, ...input, token: expect.any(String) });
    await first.close();

    expect(await open().list(document)).toEqual([saved]);
  });

  it("captures the input before opening IndexedDB and does not retain mutable caller objects", async () => {
    const store = open();
    const input = draft();
    const expected = structuredClone(input);
    const saving = store.write(scope, input);
    input.content.elements[0]!.x = 99;
    input.base.content.elements[0]!.x = 88;
    input.content.files["local-image"]!.dataURL = "changed-after-capture";
    input.submitted.sceneKey = "changed-after-capture";
    const saved = await saving;

    expect(saved).toEqual({ ...scope, ...expected, token: expect.any(String) });
    if (!saved) throw new Error("draft was not persisted");
    saved.content.elements[0]!.x = 77;
    expect((await store.list(document))[0]?.content).toEqual(expected.content);
  });

  it("captures document and client keys before asynchronous writes, lists and acknowledgements", async () => {
    const store = open();
    const mutableScope = { ...scope };
    const writing = store.write(mutableScope, draft());
    mutableScope.canvasId = "changed-after-write";
    const saved = await writing;
    if (!saved) throw new Error("draft was not persisted");
    expect(saved.canvasId).toBe("canvas-a");
    const listing = store.list(mutableScope);
    mutableScope.canvasId = scope.canvasId;
    expect(await listing).toEqual([]);
    const acknowledging = store.acknowledge(mutableScope, saved.token);
    mutableScope.clientId = "changed-after-acknowledgement";
    expect(await acknowledging).toBe(true);
    expect(await store.list(document)).toEqual([]);
  });

  it("keeps separate client drafts and isolates project and canvas compound keys", async () => {
    const store = open();
    const scopes = [
      scope,
      { ...scope, clientId: "tab-b" },
      { ...scope, projectId: "project-b" },
      { ...scope, canvasId: "canvas-b" },
      { projectId: "project:a", canvasId: "b", clientId: "tab-a" },
      { projectId: "project", canvasId: "a:b", clientId: "tab-a" },
    ];
    const saved = await Promise.all(
      scopes.map((item, index) => store.write(item, draft(index + 1))),
    );

    expect(await store.list(document)).toEqual([saved[0], saved[1]]);
    for (let index = 2; index < scopes.length; index++) {
      expect(await store.list(scopes[index]!)).toEqual([saved[index]]);
    }
  });

  it("atomically keeps the newer generation across independent connections", async () => {
    const first = open();
    const second = open();
    const [newer, older] = await Promise.all([
      first.write(scope, draft(2)),
      second.write(scope, draft(1)),
    ]);

    expect(older).toBeNull();
    expect(await first.list(document)).toEqual([newer]);
    expect(await second.write(scope, draft(2))).toBeNull();
    expect(await second.list(document)).toEqual([newer]);
  });

  it("treats A to B to A as a new edit and does not let B's acknowledgement clear the reverted A", async () => {
    const store = open();
    const a = draft(1);
    const b = draft(2);
    await store.write(scope, a);
    const submittedB = await store.write(scope, b);
    const revertedA = await store.write(scope, {
      ...a,
      generation: 3,
      submitted: b.submitted,
    });
    if (!submittedB || !revertedA) throw new Error("draft was not persisted");

    expect(revertedA.content).toEqual(a.content);
    expect(await store.acknowledge(scope, submittedB.token)).toBe(false);
    expect(await store.write(scope, b)).toBeNull();
    expect(await store.list(document)).toEqual([revertedA]);
    expect(await store.acknowledge(scope, revertedA.token)).toBe(true);
    expect(await store.list(document)).toEqual([]);
  });

  it("persists stable references and new image bytes while dropping signed fetch URLs from both scenes", async () => {
    const store = open();
    const files: CanvasContent["files"] = {
      stored: {
        id: "stored",
        mimeType: "image/png",
        storageRef: "project-file://stable-image",
        storageUrl: "http://localhost:3001/file?access_token=do-not-persist",
        dataURL: "data:image/png;base64,already-stored-bytes",
      },
      pending: draft().content.files["local-image"]!,
      signed: {
        id: "signed",
        mimeType: "image/png",
        dataURL: "https://storage.example/image?signature=do-not-persist",
        storageUrl: "http://localhost:3001/file?access_token=do-not-persist",
      },
    };
    const content: CanvasContent = { ...base, files };
    const saved = await store.write(scope, {
      ...draft(),
      content,
      base: { revision: "r1", content },
    });
    const expected = {
      stored: {
        id: "stored",
        mimeType: "image/png",
        storageRef: "project-file://stable-image",
      },
      pending: draft().content.files["local-image"]!,
      signed: { id: "signed", mimeType: "image/png" },
    };

    expect(saved?.content.files).toEqual(expected);
    expect(saved?.base.content.files).toEqual(expected);
    expect(JSON.stringify(await store.list(document))).not.toContain(
      "do-not-persist",
    );
    expect(files.stored).toHaveProperty("storageUrl");
  });

  it("a stale or foreign acknowledgement cannot remove newer edits or another client's draft", async () => {
    const first = open();
    const second = open();
    const older = await first.write(scope, draft(1));
    const otherScope = { ...scope, clientId: "tab-b" };
    const other = await second.write(otherScope, draft(1));
    const newer = await second.write(scope, draft(2));
    if (!older || !newer || !other) throw new Error("draft was not persisted");

    expect(await first.acknowledge(scope, older.token)).toBe(false);
    expect(await first.acknowledge(scope, other.token)).toBe(false);
    expect(await first.acknowledge(otherScope, newer.token)).toBe(false);
    expect(await first.list(document)).toEqual([newer, other]);
  });

  it("clears only the matching draft and prevents a late old write from reviving it after reopening", async () => {
    const first = open();
    const saved = await first.write(scope, draft(2));
    if (!saved) throw new Error("draft was not persisted");
    expect(await first.acknowledge(scope, saved.token)).toBe(true);
    expect(await first.acknowledge(scope, saved.token)).toBe(false);
    expect(await first.list(document)).toEqual([]);
    await first.close();

    const reopened = open();
    expect(await reopened.write(scope, draft(1))).toBeNull();
    expect(await reopened.write(scope, draft(2))).toBeNull();
    expect(await reopened.list(document)).toEqual([]);
    const newer = await reopened.write(scope, draft(3));
    expect(newer?.token).not.toBe(saved.token);
    expect(await reopened.acknowledge(scope, saved.token)).toBe(false);
    expect(await reopened.list(document)).toEqual([newer]);
  });

  it("keeps an intentional empty scene as a recoverable draft", async () => {
    const store = open();
    const input = {
      ...draft(),
      content: { elements: [], appState: {}, files: {} },
    };
    const saved = await store.write(scope, input);
    await store.close();

    expect(await open().list(document)).toEqual([saved]);
    expect(saved?.content).toEqual({ elements: [], appState: {}, files: {} });
  });

  it("reports unavailable storage instead of treating an unsaved scene as durable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const store = createCanvasDraftStore({
      databaseName: "unavailable-drafts",
    });

    await expect(store.write(scope, draft())).rejects.toThrow();
    await expect(store.list(document)).rejects.toThrow();
    await store.close();
  });

  it("reports IndexedDB opening failures and leaves existing records recoverable", async () => {
    const first = open();
    const saved = await first.write(scope, draft(1));
    await first.close();
    const failure = new DOMException("storage denied", "SecurityError");
    const openRequest = vi
      .spyOn(indexedDB, "open")
      .mockImplementationOnce(() => {
        throw failure;
      });
    const failed = open();
    await expect(failed.write(scope, draft(2))).rejects.toBe(failure);
    await failed.close();
    openRequest.mockRestore();

    expect(await open().list(document)).toEqual([saved]);
  });

  it("does not replace the previous recoverable draft when a new snapshot cannot be cloned", async () => {
    const store = open();
    const saved = await store.write(scope, draft(1));
    const invalid: CanvasContent = {
      ...base,
      appState: { uncloneable: () => "not persistable" },
    };

    await expect(
      store.write(scope, { ...draft(2), content: invalid }),
    ).rejects.toMatchObject({ name: "DataCloneError" });
    expect(await store.list(document)).toEqual([saved]);
  });
});
