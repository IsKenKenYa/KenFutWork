import type { CanvasContent } from "@kenfutwork/shared";
import { expect, test } from "vitest";
import {
  createCanvasSceneState,
  reconcileCanvasScene,
} from "../src/lib/canvas-scene-state";
import { loadRealRestoreElements } from "./setup/real-excalidraw-restore";

const content: CanvasContent = {
  elements: [{ id: "a", type: "rectangle", x: 0 }],
  appState: { viewBackgroundColor: "#fff", gridModeEnabled: false },
  files: {},
};

test("viewport and selection do not change the document scene; background and grid do", () => {
  const state = createCanvasSceneState({ revision: "r1", content });
  expect(
    state.observe({
      ...content,
      appState: {
        ...content.appState,
        scrollX: 10,
        scrollY: 20,
        zoom: { value: 2 },
        selectedElementIds: { a: true },
      },
    }),
  ).toBe(false);
  expect(state.isDirty).toBe(false);
  expect(
    state.observe({
      ...content,
      appState: { ...content.appState, viewBackgroundColor: "#000" },
    }),
  ).toBe(true);
  expect(state.isDirty).toBe(true);
  expect(
    state.observe({
      ...content,
      appState: { ...content.appState, gridModeEnabled: true },
    }),
  ).toBe(true);
});

test("save ACK only confirms the frozen submitted scene while newer edits stay dirty", () => {
  const state = createCanvasSceneState({ revision: "r1", content });
  const first = { ...content, elements: [{ ...content.elements[0], x: 1 }] };
  const second = { ...content, elements: [{ ...content.elements[0], x: 2 }] };
  const submitted = state.captureSave(first);
  state.observe(second);
  const newerVersion = state.version;
  state.acknowledgeSave(submitted, "r2");
  expect(state.version).toBe(newerVersion);
  expect(state.isDirty).toBe(true);
  state.acknowledgeSave(state.captureSave(second), "r3");
  expect(state.isDirty).toBe(false);
  state.acknowledgeSave(submitted, "r2");
  expect(state.isDirty).toBe(false);
  expect(state.hasKnownRevision("r1")).toBe(true);
  expect(state.hasKnownRevision("r2")).toBe(true);
  expect(state.hasKnownRevision("r3")).toBe(true);
});

test("scene fingerprints are frozen even if the source object is mutated afterwards", () => {
  const live = structuredClone(content);
  const state = createCanvasSceneState({ revision: "r1", content: live });
  live.elements[0]!.x = 1;
  const submitted = state.captureSave(live);
  live.elements[0]!.x = 2;
  state.observe(live);
  state.acknowledgeSave(submitted, "r2");
  expect(state.isDirty).toBe(true);
  state.acceptRemote(content, "r3");
  expect(state.isDirty).toBe(false);
});

test("three-way reconciliation keeps independent additions and moves", () => {
  const a = content.elements[0]!;
  const b = { id: "b", type: "rectangle", x: 0 };
  const localNew = { id: "local-new", type: "rectangle", x: 10 };
  const remoteNew = { id: "remote-new", type: "image", fileId: "file-a" };
  const base = { ...content, elements: [a, b] };
  const result = reconcileCanvasScene({
    base,
    local: { ...base, elements: [{ ...a, x: 25 }, b, localNew] },
    remote: { ...base, elements: [a, { ...b, x: 40 }, remoteNew] },
  });
  expect(result?.merged.elements).toEqual([
    { ...a, x: 25 },
    { ...b, x: 40 },
    localNew,
    remoteNew,
  ]);
  expect(base.elements).toEqual([a, b]);
});

test("remote deletion is not revived by an unrelated local move", () => {
  const a = content.elements[0]!;
  const b = { id: "b", type: "rectangle", x: 0 };
  const base = { ...content, elements: [a, b] };
  const result = reconcileCanvasScene({
    base,
    local: { ...base, elements: [a, { ...b, x: 25 }] },
    remote: { ...base, elements: [b] },
  });
  expect(result?.merged.elements).toEqual([{ ...b, x: 25 }]);
});

test.each([false, true])(
  "local deletion keeps a tombstone for the pending empty save (explicit tombstone: %s)",
  (explicit) => {
    const a = content.elements[0]!;
    const result = reconcileCanvasScene({
      base: content,
      local: {
        ...content,
        elements: explicit ? [{ ...a, isDeleted: true }] : [],
      },
      remote: content,
    });
    expect(result?.merged.elements).toEqual([{ ...a, isDeleted: true }]);
    expect(result?.remote.elements).toEqual([a]);
  },
);

test.each([
  { local: [{ id: "a", x: 25 }], remote: [{ id: "a", x: 40 }] },
  { local: [{ id: "a", x: 25 }], remote: [] },
  { local: [], remote: [{ id: "a", x: 40 }] },
  {
    local: [...content.elements, { id: "new", x: 25 }],
    remote: [...content.elements, { id: "new", x: 40 }],
  },
])("different changes to the same element remain a conflict: %j", (fixture) => {
  expect(
    reconcileCanvasScene({
      base: content,
      local: { ...content, elements: fixture.local },
      remote: { ...content, elements: fixture.remote },
    }),
  ).toBeNull();
});

test("identical element changes ignore JSON object key order", () => {
  const result = reconcileCanvasScene({
    base: content,
    local: { ...content, elements: [{ id: "a", type: "rectangle", x: 25 }] },
    remote: { ...content, elements: [{ x: 25, type: "rectangle", id: "a" }] },
  });
  expect(result?.merged.elements).toEqual([
    { id: "a", type: "rectangle", x: 25 },
  ]);
});

test("document settings merge per field and omit viewport and selection", () => {
  const result = reconcileCanvasScene({
    base: content,
    local: {
      ...content,
      appState: {
        ...content.appState,
        viewBackgroundColor: "#000",
        scrollX: -20,
      },
    },
    remote: {
      ...content,
      appState: {
        ...content.appState,
        gridModeEnabled: true,
        selectedElementIds: { a: true },
      },
    },
  });
  expect(result?.merged.appState).toEqual({
    viewBackgroundColor: "#000",
    gridModeEnabled: true,
  });
  expect(result?.remote.appState).toEqual({
    viewBackgroundColor: "#fff",
    gridModeEnabled: true,
  });
  expect(
    reconcileCanvasScene({
      base: content,
      local: { ...content, appState: { viewBackgroundColor: "#000" } },
      remote: { ...content, appState: { viewBackgroundColor: "#eee" } },
    }),
  ).toBeNull();
});

test("rebasing a merged draft advances only the remote baseline until its save is acknowledged", () => {
  const state = createCanvasSceneState({ revision: "r1", content });
  const local = { ...content, elements: [{ ...content.elements[0], x: 25 }] };
  const remote = {
    ...content,
    elements: [...content.elements, { id: "remote", x: 40 }],
  };
  state.observe(local);
  const result = state.reconcileRemote(local, remote);
  expect(result).not.toBeNull();
  if (!result) return;
  state.acceptRemote(result.remote, "r2");
  state.observe(result.merged);
  expect(state.isDirty).toBe(true);
  state.acknowledgeSave(state.captureSave(result.merged), "r3");
  expect(state.isDirty).toBe(false);
  expect(state.hasKnownRevision("r2")).toBe(true);
});

test("a single local layer reorder is kept while a conflicting remote reorder is rejected", () => {
  const a = content.elements[0]!;
  const b = { id: "b", x: 0 };
  const c = { id: "c", x: 0 };
  const base = { ...content, elements: [a, b, c] };
  expect(
    reconcileCanvasScene({
      base,
      local: { ...base, elements: [b, a, c] },
      remote: base,
    })?.merged.elements,
  ).toEqual([b, a, c]);
  expect(
    reconcileCanvasScene({
      base,
      local: { ...base, elements: [b, a, c] },
      remote: { ...base, elements: [a, c, b] },
    }),
  ).toBeNull();
});

test("real restoreElements hydration preserves the confirmed sparse remote baseline for later reconciliation", async () => {
  const restoreElements = await loadRealRestoreElements();
  const sparse = {
    id: "a",
    type: "rectangle",
    x: 0,
    y: 0,
    width: 20,
    height: 20,
  };
  const initial = { ...content, elements: [sparse] };
  const restored = restoreElements(
    initial.elements as unknown as Parameters<typeof restoreElements>[0],
    null,
  );
  const state = createCanvasSceneState({ revision: "r1", content: initial });
  state.hydrate({ ...initial, elements: restored });
  const local = {
    ...restored[0]!,
    x: 25,
    version: restored[0]!.version + 1,
    versionNonce: 123,
    updated: Date.now() + 1,
  };
  const latest = { ...initial, elements: [local] };
  const remoteResult = { ...sparse, id: "remote-result", x: 80 };
  state.observe(latest);
  const remote = {
    ...initial,
    elements: [sparse, remoteResult],
  };
  const result = state.reconcileRemote(latest, remote);
  expect(result?.merged.elements).toEqual([local, remoteResult]);
  expect(state.isDirty).toBe(true);
  if (!result) return;
  state.acceptRemote(result.remote, "r2", remote);
  state.observe(result.merged);
  const laterResult = { ...sparse, id: "later-result", x: 120 };
  expect(
    state.reconcileRemote(result.merged, {
      ...remote,
      elements: [...remote.elements, laterResult],
    })?.merged.elements,
  ).toEqual([local, remoteResult, laterResult]);
  expect(state.isDirty).toBe(true);
});

test("a confirmed real saved snapshot retains meaningful version and updated conflicts", async () => {
  const restoreElements = await loadRealRestoreElements();
  const sparse = {
    id: "a",
    type: "rectangle",
    x: 0,
    y: 0,
    width: 20,
    height: 20,
  };
  const restored = restoreElements(
    [sparse] as unknown as Parameters<typeof restoreElements>[0],
    null,
  );
  const initial = { ...content, elements: [sparse] };
  const state = createCanvasSceneState({ revision: "r1", content: initial });
  state.hydrate({ ...initial, elements: restored });
  const savedElement = {
    ...restored[0]!,
    x: 25,
    version: restored[0]!.version + 1,
    versionNonce: 123,
    updated: 100,
  };
  const submitted = { ...initial, elements: [savedElement] };
  state.acknowledgeSave(state.captureSave(submitted), "r2");
  const local = {
    ...submitted,
    elements: [
      {
        ...savedElement,
        x: 30,
        version: savedElement.version + 1,
        updated: 200,
      },
    ],
  };
  state.observe(local);
  for (const remoteElement of [
    { ...savedElement, version: savedElement.version + 1 },
    { ...savedElement, updated: 300 },
  ]) {
    expect(
      state.reconcileRemote(local, {
        ...submitted,
        elements: [remoteElement],
      }),
    ).toBeNull();
  }
});
