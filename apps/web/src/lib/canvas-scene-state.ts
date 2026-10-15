import type { CanvasContent } from "@kenfutwork/shared";

type CanvasScene = {
  elements: readonly Record<string, unknown>[];
  appState: Record<string, unknown>;
};

/** 文档设置与视口/选区分开；后者始终留在当前编辑器。 */
export function canvasDocumentSettings(appState: {
  viewBackgroundColor?: unknown;
  gridModeEnabled?: unknown;
}) {
  return {
    viewBackgroundColor: appState.viewBackgroundColor,
    gridModeEnabled: appState.gridModeEnabled,
  };
}

function sceneKey(scene: CanvasScene): string {
  return JSON.stringify([
    scene.elements.filter((element) => !element.isDeleted),
    canvasDocumentSettings(scene.appState),
  ]);
}

export function createCanvasSceneState(initial: {
  revision: string;
  content: CanvasContent;
}) {
  let currentKey = sceneKey(initial.content);
  let savedKey = currentKey;
  let version = 0;
  let savedVersion = 0;
  const knownRevisions = new Set([initial.revision]);
  const observe = (scene: CanvasScene): boolean => {
    const next = sceneKey(scene);
    if (next === currentKey) return false;
    currentKey = next;
    version++;
    return true;
  };
  return {
    observe,
    hydrate(scene: CanvasScene) {
      observe(scene);
      savedKey = currentKey;
      savedVersion = version;
    },
    captureSave(scene: CanvasScene) {
      observe(scene);
      return { key: currentKey, version };
    },
    acknowledgeSave(
      snapshot: { key: string; version: number },
      revision: string,
    ) {
      knownRevisions.add(revision);
      if (snapshot.version < savedVersion) return;
      savedKey = snapshot.key;
      savedVersion = snapshot.version;
    },
    acceptRemote(scene: CanvasScene, revision: string) {
      observe(scene);
      savedKey = currentKey;
      savedVersion = version;
      knownRevisions.add(revision);
    },
    hasKnownRevision(revision: string) {
      return knownRevisions.has(revision);
    },
    get isDirty() {
      return currentKey !== savedKey;
    },
    get version() {
      return version;
    },
  };
}
