import {
  directoryPickerStatusSchema,
  type PickDirectoryResponse,
  type ProjectDirectoryRelinkSnapshot,
  projectDirectoryRelinkResponseSchema,
  projectDirectoryRelinkSnapshotSchema,
} from "@kenfutwork/shared";
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { surfaceFetch, surfaceJson } from "./surfaceApi.js";

export function useDirectoryPickerAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let current = true;
    void surfaceJson("/api/system/directory-picker")
      .then((body) => {
        if (current)
          setAvailable(directoryPickerStatusSchema.parse(body).available);
      })
      .catch(() => {
        if (current) setAvailable(false);
      });
    return () => {
      current = false;
    };
  }, []);
  return available;
}

export async function pickCanvasProjectDirectory(): Promise<string | null> {
  const picked = await surfaceJson<PickDirectoryResponse>(
    "/api/system/pick-directory",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  if (picked.status === "cancelled") return null;
  if (picked.status !== "picked") throw new Error(picked.reason);
  return picked.path;
}

type DirectoryKind = "design" | "flow";
type DirectoryState = {
  projectId: string | null;
  snapshot: ProjectDirectoryRelinkSnapshot | null;
  checking: boolean;
  error: string | null;
};

async function readDirectorySnapshot(projectId: string, kind?: DirectoryKind) {
  const url = `/api/projects/${encodeURIComponent(projectId)}/relink-directory`;
  if (!kind)
    return projectDirectoryRelinkSnapshotSchema.parse(await surfaceJson(url));
  const response = await surfaceFetch(url);
  const body = await response.json();
  if (
    kind === "design" &&
    response.status === 400 &&
    body.error?.message === "原项目目录仍存在，不能重新关联。"
  )
    return null;
  if (!response.ok)
    throw new Error(body.error?.message ?? "项目目录状态无法读取。");
  const snapshot = projectDirectoryRelinkSnapshotSchema.parse(body);
  if (kind === "flow" && !snapshot.flow)
    throw new Error("Flow 项目绑定缺失，请刷新项目。");
  return snapshot;
}

async function submitDirectoryRelink(
  snapshot: ProjectDirectoryRelinkSnapshot,
  path: string,
) {
  const flow = snapshot.flow;
  return projectDirectoryRelinkResponseSchema.parse(
    await surfaceJson(
      `/api/projects/${encodeURIComponent(snapshot.projectId)}/relink-directory`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedWorkDir: flow?.previousWorkDir ?? snapshot.workDir,
          nextWorkDir: path,
          expectedTasks: flow ? [] : snapshot.tasks,
          ...(flow
            ? {
                expectedFlow: {
                  generation: flow.generation,
                  operationId: flow.operationId,
                },
              }
            : {}),
        }),
      },
    ),
  );
}

function useDirectorySnapshot(
  kind: DirectoryKind,
  projectId: string | null,
  revision: number,
) {
  const [state, setState] = useState<DirectoryState>({
    projectId: null,
    snapshot: null,
    checking: false,
    error: null,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: successful relink must re-read the authoritative generation.
  useEffect(() => {
    let current = true;
    setState({
      projectId,
      snapshot: null,
      checking: Boolean(projectId),
      error: null,
    });
    if (projectId)
      void (async () => {
        try {
          const snapshot = await readDirectorySnapshot(projectId, kind);
          if (current)
            setState({ projectId, snapshot, checking: false, error: null });
        } catch (failure) {
          if (current)
            setState({
              projectId,
              snapshot: null,
              checking: false,
              error:
                failure instanceof Error
                  ? failure.message
                  : "目录状态无法读取。",
            });
        } finally {
          if (current) setState((value) => ({ ...value, checking: false }));
        }
      })();
    return () => {
      current = false;
    };
  }, [kind, projectId, revision]);
  return { state, setState };
}

async function observeFailedRelink(
  attemptedSnapshot: ProjectDirectoryRelinkSnapshot,
) {
  try {
    return {
      snapshot: await readDirectorySnapshot(attemptedSnapshot.projectId),
      uncertain: false,
    };
  } catch {
    return { snapshot: attemptedSnapshot, uncertain: true };
  }
}

function useDirectoryRecovery(
  snapshot: ProjectDirectoryRelinkSnapshot | null,
  projectId: string | null,
  setState: Dispatch<SetStateAction<DirectoryState>>,
  confirmed: () => void,
) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const uncertainProjectRef = useRef<string | null>(null);
  const pickedDirectoryRef = useRef<{ projectId: string; path: string } | null>(
    null,
  );
  const selectedProjectRef = useRef(projectId);
  selectedProjectRef.current = projectId;
  const recover = async () => {
    if (!snapshot || busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    let attemptedSnapshot = snapshot;
    try {
      if (uncertainProjectRef.current === snapshot.projectId) {
        const observation = await observeUncertainRelink(snapshot);
        if (selectedProjectRef.current === snapshot.projectId) {
          if (!observation.error) uncertainProjectRef.current = null;
          setState((value) => ({ ...value, ...observation }));
        }
        return null;
      }
      const flow = snapshot.flow;
      const path =
        flow && flow.phase !== "idle"
          ? flow.nextWorkDir
          : pickedDirectoryRef.current?.projectId === snapshot.projectId
            ? pickedDirectoryRef.current.path
            : await pickCanvasProjectDirectory();
      if (!path) return null;
      if (selectedProjectRef.current !== snapshot.projectId) return null;
      pickedDirectoryRef.current = { projectId: snapshot.projectId, path };
      if (flow)
        attemptedSnapshot = {
          ...snapshot,
          flow: {
            ...flow,
            nextWorkDir: path,
            phase: flow.phase === "idle" ? "staged" : flow.phase,
          },
        };
      const receipt = await submitDirectoryRelink(snapshot, path);
      if (selectedProjectRef.current !== snapshot.projectId) return null;
      if (flow && receipt.flow?.phase !== "complete") {
        setState((value) => ({
          ...value,
          snapshot: { ...snapshot, flow: receipt.flow ?? flow },
          error: "Flow 目录恢复尚未确认，请继续同一操作。",
        }));
        return null;
      }
      pickedDirectoryRef.current = null;
      confirmed();
      return receipt;
    } catch (failure) {
      if (selectedProjectRef.current !== snapshot.projectId) return null;
      // A lost response can mean the root was already published: refresh the same
      // operation before allowing continuation, never ask for a second target.
      const observation = await observeFailedRelink(attemptedSnapshot);
      if (observation.uncertain)
        uncertainProjectRef.current = snapshot.projectId;
      if (selectedProjectRef.current === snapshot.projectId)
        setState((value) => ({
          ...value,
          snapshot: observation.snapshot,
          error:
            failure instanceof Error
              ? failure.message
              : "目录关联失败，请重试。",
        }));
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return { busy, recover };
}

async function observeUncertainRelink(
  snapshot: ProjectDirectoryRelinkSnapshot,
) {
  try {
    return {
      snapshot: await readDirectorySnapshot(snapshot.projectId),
      error: null,
    };
  } catch (failure) {
    return {
      snapshot,
      error:
        failure instanceof Error
          ? failure.message
          : "恢复状态无法确认，请刷新后重试。",
    };
  }
}

/** Missing Design roots and Flow generation barriers come only from the server. */
export function useCanvasProjectDirectory(
  kind: DirectoryKind,
  projectId: string | null,
) {
  const [revision, setRevision] = useState(0);
  const { state, setState } = useDirectorySnapshot(kind, projectId, revision);
  const snapshot = state.projectId === projectId ? state.snapshot : null;
  const { busy, recover } = useDirectoryRecovery(
    snapshot,
    projectId,
    setState,
    () => setRevision((value) => value + 1),
  );
  return {
    snapshot,
    busy,
    recover,
    revision,
    checking: state.projectId !== projectId || state.checking,
    error: state.projectId === projectId ? state.error : null,
  };
}
