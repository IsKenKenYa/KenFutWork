import type { CanvasContent } from "@kenfutwork/shared";

type CanvasScene = {
  elements: readonly Record<string, unknown>[];
  appState: Record<string, unknown>;
};

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return (
    keys.length ===
      Object.keys(b).filter((key) => b[key] !== undefined).length &&
    keys.every((key) => sameValue(a[key], b[key]))
  );
}

function mergeValue<T>(base: T, local: T, remote: T): { value: T } | null {
  if (sameValue(local, remote) || sameValue(base, remote))
    return { value: local };
  if (sameValue(base, local)) return { value: remote };
  return null;
}

function liveElements(scene: CanvasScene) {
  return scene.elements.filter((element) => !element.isDeleted);
}

function mergeElementOrder(
  base: CanvasScene["elements"],
  local: CanvasScene["elements"],
  remote: CanvasScene["elements"],
  merged: Map<unknown, Record<string, unknown>>,
) {
  const baseIds = new Set(base.map((element) => element.id));
  const survivingOrder = (elements: CanvasScene["elements"]) =>
    elements
      .filter((element) => baseIds.has(element.id) && merged.has(element.id))
      .map((element) => element.id);
  const localOrder = survivingOrder(local);
  const remoteOrder = survivingOrder(remote);
  const localReordered = !sameValue(survivingOrder(base), localOrder);
  if (localReordered && !sameValue(localOrder, remoteOrder)) {
    if (!sameValue(survivingOrder(base), remoteOrder)) return null;
  }
  const primary = localReordered ? local : remote;
  const secondary = localReordered ? remote : local;
  const ordered = primary.filter((element) => merged.has(element.id));
  const orderedIds = new Set(ordered.map((element) => element.id));
  for (let index = 0; index < secondary.length; index++) {
    const element = secondary[index]!;
    if (!merged.has(element.id) || orderedIds.has(element.id)) continue;
    const preceding = secondary
      .slice(0, index)
      .reverse()
      .find((item) => orderedIds.has(item.id));
    const following = secondary
      .slice(index + 1)
      .find((item) => orderedIds.has(item.id));
    const before = preceding
      ? ordered.findIndex((item) => item.id === preceding.id)
      : -1;
    const after = following
      ? ordered.findIndex((item) => item.id === following.id)
      : ordered.length;
    if (before >= after) return null;
    ordered.splice(before + 1, 0, element);
    orderedIds.add(element.id);
  }
  return ordered.map((element) => merged.get(element.id)!);
}

/** 缺席/墓碑均表示删除；同一元素的不同改动不能自动覆盖。 */
export function reconcileCanvasScene(options: {
  base: CanvasScene;
  local: CanvasScene;
  remote: CanvasScene;
}): { remote: CanvasScene; merged: CanvasScene } | null {
  const base = liveElements(options.base);
  const local = liveElements(options.local);
  const remote = liveElements(options.remote);
  const baseById = new Map(base.map((element) => [element.id, element]));
  const localById = new Map(local.map((element) => [element.id, element]));
  const localAllById = new Map(
    options.local.elements.map((element) => [element.id, element]),
  );
  const remoteById = new Map(remote.map((element) => [element.id, element]));
  if (
    [base, local, remote].some((elements) =>
      elements.some((element) => typeof element.id !== "string"),
    ) ||
    baseById.size !== base.length ||
    localById.size !== local.length ||
    remoteById.size !== remote.length
  )
    return null;
  const merged = new Map<unknown, Record<string, unknown>>();
  const ids = new Set([
    ...baseById.keys(),
    ...localById.keys(),
    ...remoteById.keys(),
  ]);
  for (const id of ids) {
    const result = mergeValue(
      baseById.get(id),
      localById.get(id),
      remoteById.get(id),
    );
    if (!result) return null;
    if (result.value) merged.set(id, result.value);
  }
  const elements = mergeElementOrder(base, local, remote, merged);
  if (!elements) return null;
  // 未保存的本地删除仍需墓碑，空场景保存才能区分显式删除与初始化空帧。
  const deletions = base
    .filter((element) => !merged.has(element.id) && remoteById.has(element.id))
    .map((element) => ({
      ...(localAllById.get(element.id) ?? element),
      isDeleted: true,
    }));
  const appState: Record<string, unknown> = {};
  const remoteSettings: Record<string, unknown> = {};
  for (const key of ["viewBackgroundColor", "gridModeEnabled"] as const) {
    const baseline = options.base.appState[key];
    const localValue = options.local.appState[key] ?? baseline;
    const remoteValue = options.remote.appState[key] ?? baseline;
    const result = mergeValue(baseline, localValue, remoteValue);
    if (!result) return null;
    appState[key] = result.value;
    remoteSettings[key] = remoteValue;
  }
  return {
    remote: { elements: remote, appState: remoteSettings },
    merged: { elements: [...elements, ...deletions], appState },
  };
}

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
    reconcileRemote(local: CanvasScene, remote: CanvasScene) {
      const [elements, appState] = JSON.parse(savedKey) as [
        CanvasScene["elements"],
        CanvasScene["appState"],
      ];
      return reconcileCanvasScene({
        base: { elements, appState },
        local,
        remote,
      });
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
