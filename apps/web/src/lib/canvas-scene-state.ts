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

/** 只继承同一确认快照在 hydrate 时产生的表示差异；远端真实字段变化仍保留。 */
function projectRemoteElement(
  confirmed: Record<string, unknown> | undefined,
  hydrated: Record<string, unknown> | undefined,
  remote: Record<string, unknown>,
) {
  if (sameValue(confirmed, remote)) return hydrated;
  if (!confirmed || !hydrated) return remote;
  const projected = { ...remote };
  for (const [key, value] of Object.entries(hydrated)) {
    if (sameValue(confirmed[key], remote[key])) projected[key] = value;
  }
  return projected;
}

function hasUniqueElementIds(elements: CanvasScene["elements"]) {
  const ids = elements.map((element) => element.id);
  return (
    ids.every((id) => typeof id === "string") &&
    new Set(ids).size === ids.length
  );
}

function mergeDocumentSettings(
  confirmed: CanvasScene["appState"],
  baseline: CanvasScene["appState"],
  local: CanvasScene["appState"],
  remote: CanvasScene["appState"],
) {
  const merged: Record<string, unknown> = {};
  const projected: Record<string, unknown> = {};
  for (const key of ["viewBackgroundColor", "gridModeEnabled"] as const) {
    const incoming = remote[key] ?? confirmed[key];
    const remoteValue = sameValue(confirmed[key], incoming)
      ? baseline[key]
      : incoming;
    const result = mergeValue(
      baseline[key],
      local[key] ?? baseline[key],
      remoteValue,
    );
    if (!result) return null;
    merged[key] = result.value;
    projected[key] = remoteValue;
  }
  return { merged, projected };
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
  localBase?: CanvasScene;
  local: CanvasScene;
  remote: CanvasScene;
}): { remote: CanvasScene; merged: CanvasScene } | null {
  const localBaseline = options.localBase ?? options.base;
  const confirmed = liveElements(options.base);
  const base = liveElements(localBaseline);
  const local = liveElements(options.local);
  const rawRemote = liveElements(options.remote);
  const confirmedById = new Map(
    confirmed.map((element) => [element.id, element]),
  );
  const baseById = new Map(base.map((element) => [element.id, element]));
  const localById = new Map(local.map((element) => [element.id, element]));
  const localAllById = new Map(
    options.local.elements.map((element) => [element.id, element]),
  );
  if (
    [confirmed, base, local, rawRemote].some(
      (elements) => !hasUniqueElementIds(elements),
    )
  )
    return null;
  const remote = rawRemote.flatMap((element) => {
    const projected = projectRemoteElement(
      confirmedById.get(element.id),
      baseById.get(element.id),
      element,
    );
    return projected ? [projected] : [];
  });
  const remoteById = new Map(remote.map((element) => [element.id, element]));
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
  const settings = mergeDocumentSettings(
    options.base.appState,
    localBaseline.appState,
    options.local.appState,
    options.remote.appState,
  );
  if (!settings) return null;
  return {
    remote: { elements: remote, appState: settings.projected },
    merged: {
      elements: [...elements, ...deletions],
      appState: settings.merged,
    },
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

export function canvasSceneKey(scene: CanvasScene): string {
  return JSON.stringify([
    scene.elements.filter((element) => !element.isDeleted),
    canvasDocumentSettings(scene.appState),
  ]);
}

export function canvasSceneFromKey(key: string): CanvasScene {
  const [elements, appState] = JSON.parse(key) as [
    CanvasScene["elements"],
    CanvasScene["appState"],
  ];
  return { elements, appState };
}

export function createCanvasSceneState(initial: {
  revision: string;
  content: CanvasContent;
}) {
  let currentKey = canvasSceneKey(initial.content);
  let savedKey = currentKey;
  let confirmedKey = currentKey;
  let version = 0;
  let savedVersion = 0;
  const knownRevisions = new Set([initial.revision]);
  const observe = (scene: CanvasScene): boolean => {
    const next = canvasSceneKey(scene);
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
      confirmedKey = snapshot.key;
      savedVersion = snapshot.version;
    },
    acceptRemote(scene: CanvasScene, revision: string, confirmed = scene) {
      observe(scene);
      savedKey = currentKey;
      confirmedKey = canvasSceneKey(confirmed);
      savedVersion = version;
      knownRevisions.add(revision);
    },
    reconcileRemote(local: CanvasScene, remote: CanvasScene) {
      return reconcileCanvasScene({
        base: canvasSceneFromKey(confirmedKey),
        localBase: canvasSceneFromKey(savedKey),
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
    get baseline() {
      return {
        confirmed: canvasSceneFromKey(confirmedKey),
        local: canvasSceneFromKey(savedKey),
      };
    },
  };
}
