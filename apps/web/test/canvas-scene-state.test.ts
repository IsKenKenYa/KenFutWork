import type { CanvasContent } from "@kenfutwork/shared";
import { expect, test } from "vitest";
import { createCanvasSceneState } from "../src/lib/canvas-scene-state";

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
