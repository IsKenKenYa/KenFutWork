import {
  type ContextRequestSummary,
  contextRequestListSchema,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InspectionCall } from "./contextInspectionReader.js";

export function useContextRequestList(call: InspectionCall, taskId: string) {
  const [requests, setRequests] = useState<ContextRequestSummary[]>([]);
  const [selectedId, select] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const current = useRef<AbortController | null>(null);
  const list = useCallback(
    async (before?: number) => {
      current.current?.abort();
      const controller = new AbortController();
      current.current = controller;
      setBusy(true);
      setError(null);
      try {
        const page = contextRequestListSchema.parse(
          await call("list", [{ taskId, ...(before ? { before } : {}) }]),
        );
        controller.signal.throwIfAborted();
        setRequests((old) =>
          before === undefined
            ? page.requests
            : [
                ...old,
                ...page.requests.filter((r) => !old.some((p) => p.id === r.id)),
              ],
        );
        setNextBefore(page.nextBefore);
        if (before === undefined) {
          select(page.requests[0]?.id ?? null);
          setGeneration((n) => n + 1);
        }
      } catch {
        if (!controller.signal.aborted) setError("请求列表读取失败，请重试。");
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [call, taskId],
  );
  useEffect(() => {
    void list();
    return () => current.current?.abort();
  }, [list]);
  return {
    requests,
    selectedId,
    select,
    nextBefore,
    error,
    busy,
    generation,
    refresh: () => list(),
    loadMore: () => (nextBefore ? list(nextBefore) : Promise.resolve()),
  };
}
