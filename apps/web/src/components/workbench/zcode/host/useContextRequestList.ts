import {
  type ContextRequestSummary,
  contextRequestListSchema,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  contextInspectionErrorMessage,
  type InspectionCall,
} from "./contextInspectionReader.js";

async function readPages(
  call: InspectionCall,
  taskId: string,
  before: number | undefined,
  through: number | undefined,
  signal: AbortSignal,
) {
  const requests: ContextRequestSummary[] = [];
  let cursor = before;
  for (;;) {
    signal.throwIfAborted();
    const page = contextRequestListSchema.parse(
      await call("list", [
        { taskId, ...(cursor === undefined ? {} : { before: cursor }) },
      ]),
    );
    signal.throwIfAborted();
    const next = page.nextBefore;
    if (next !== null && cursor !== undefined && next >= cursor)
      throw new Error("请求列表分页未前进。");
    const retained =
      through === undefined
        ? page.requests
        : page.requests.filter((request) => request.sequence >= through);
    requests.push(...retained);
    if (retained.length < page.requests.length) {
      const last = requests.at(-1);
      return last ? { requests, nextBefore: last.sequence } : page;
    }
    if (next === null || through === undefined || next <= through)
      return { requests, nextBefore: next };
    cursor = next;
  }
}

interface RequestListState {
  requests: ContextRequestSummary[];
  selectedId: string | null;
  nextBefore: number | null;
  error: string | null;
  busy: boolean;
}

const initial: RequestListState = {
  requests: [],
  selectedId: null,
  nextBefore: null,
  error: null,
  busy: true,
};

function cannotAccessRequests(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const status =
    "status" in error
      ? error.status
      : "statusCode" in error
        ? error.statusCode
        : null;
  return status === 401 || status === 403 || status === 404;
}

export function useContextRequestList(call: InspectionCall, taskId: string) {
  const scope = useMemo(() => ({ call, taskId }), [call, taskId]);
  const [stored, setStored] = useState({ ...initial, scope });
  const state = stored.scope === scope ? stored : initial;
  const update = useCallback(
    (transform: (old: RequestListState) => RequestListState) => {
      setStored((old) => ({
        ...transform(old.scope === scope ? old : initial),
        scope,
      }));
    },
    [scope],
  );
  const current = useRef<AbortController | null>(null);
  const list = useCallback(
    async (before?: number, through?: number) => {
      current.current?.abort();
      const controller = new AbortController();
      current.current = controller;
      update((old) => ({ ...old, busy: true, error: null }));
      try {
        const page = await readPages(
          scope.call,
          scope.taskId,
          before,
          through,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        update((old) => {
          const requests =
            before === undefined
              ? page.requests
              : [
                  ...old.requests,
                  ...page.requests.filter(
                    (r) => !old.requests.some((p) => p.id === r.id),
                  ),
                ];
          const selectedId = requests.some((r) => r.id === old.selectedId)
            ? old.selectedId
            : (requests[0]?.id ?? null);
          return {
            ...old,
            requests,
            selectedId,
            nextBefore: page.nextBefore,
            busy: false,
          };
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        update((old) => ({
          ...(cannotAccessRequests(error) ? initial : old),
          error: contextInspectionErrorMessage(
            error,
            "请求列表读取失败，请重试。",
          ),
          busy: false,
        }));
      }
    },
    [scope, update],
  );
  useEffect(() => {
    void list();
    return () => current.current?.abort();
  }, [list]);
  return {
    requests: state.requests,
    selectedId: state.selectedId,
    select: (selectedId: string) => update((old) => ({ ...old, selectedId })),
    nextBefore: state.nextBefore,
    error: state.error,
    busy: state.busy,
    refresh: () => list(undefined, state.requests.at(-1)?.sequence),
    loadMore: () =>
      state.nextBefore === null ? Promise.resolve() : list(state.nextBefore),
  };
}
