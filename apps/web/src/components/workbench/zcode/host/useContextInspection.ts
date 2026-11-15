import {
  type ContextRequestSummary,
  contextMessageSchema,
  contextRequestInputSchema,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  type InspectedRequest,
  inspectionStream,
} from "./contextInspectionModel.js";
import {
  type InspectionCall,
  readContextPart,
} from "./contextInspectionReader.js";
import { useContextRequestList } from "./useContextRequestList.js";

interface InspectedContent extends InspectedRequest {
  output: string;
}
async function loadRequest(
  call: InspectionCall,
  taskId: string,
  summary: ContextRequestSummary,
  signal: AbortSignal,
): Promise<InspectedContent> {
  const [input, output] = await Promise.all([
    readContextPart(call, taskId, summary.id, "input", signal),
    readContextPart(call, taskId, summary.id, "output", signal),
  ]);
  return {
    summary,
    input: contextRequestInputSchema.parse(JSON.parse(input)),
    output: JSON.stringify(
      z.array(contextMessageSchema).nullable().parse(JSON.parse(output)),
      null,
      2,
    ),
  };
}

export function useContextInspection(call: InspectionCall, taskId: string) {
  const list = useContextRequestList(call, taskId);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const scope = useMemo(
    () => ({ call, taskId, cache: new Map<string, InspectedContent>() }),
    [call, taskId],
  );
  const [loaded, setLoaded] = useState({
    scope,
    contents: new Map<string, InspectedContent>(),
  });
  const contents = loaded.scope === scope ? loaded.contents : null;
  const activeRead = useRef<AbortController | null>(null);
  const selected = list.requests.find((r) => r.id === list.selectedId) ?? null;
  const stream = useMemo(
    () => (selected ? inspectionStream(list.requests, selected) : []),
    [list.requests, selected],
  );

  const readSequence = useCallback(
    async (targets: ContextRequestSummary[]) => {
      activeRead.current?.abort();
      const controller = new AbortController();
      activeRead.current = controller;
      setReading(true);
      setError(null);
      try {
        for (const target of targets) {
          if (scope.cache.get(target.id)?.summary.status === target.status)
            continue;
          const value = await loadRequest(
            scope.call,
            scope.taskId,
            target,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          scope.cache.set(target.id, value);
          setLoaded({ scope, contents: new Map(scope.cache) });
        }
      } catch {
        const cancelled = controller.signal.aborted;
        controller.abort();
        if (!cancelled) setError("上下文读取失败，请重新读取。");
      } finally {
        if (activeRead.current === controller) setReading(false);
      }
    },
    [scope],
  );

  useEffect(() => {
    activeRead.current?.abort();
    if (!selected) {
      setReading(false);
      return;
    }
    const index = stream.findIndex((r) => r.id === selected.id);
    const previous = index > 0 ? stream[index - 1] : undefined;
    void readSequence([selected, ...(previous ? [previous] : [])]);
    return () => activeRead.current?.abort();
  }, [selected, stream, readSequence]);

  const inspected = useMemo(
    () =>
      stream.flatMap((r) => {
        const item = contents?.get(r.id);
        return item ? [{ input: item.input, summary: r }] : [];
      }),
    [stream, contents],
  );
  const content = selected ? (contents?.get(selected.id) ?? null) : null;
  return {
    ...list,
    selected,
    error: list.error ?? error,
    reading,
    inspected,
    content,
    outputPending: !!content && content.summary.status !== selected?.status,
    readHistory: () => readSequence(stream),
    cancelRead: () => {
      activeRead.current?.abort();
      setReading(false);
    },
  };
}
