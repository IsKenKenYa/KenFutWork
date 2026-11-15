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
  const [contents, setContents] = useState(new Map<string, InspectedContent>());
  const cache = useRef(new Map<string, InspectedContent>());
  const generation = useRef(list.generation);
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
          if (cache.current.has(target.id)) continue;
          const value = await loadRequest(
            call,
            taskId,
            target,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          cache.current.set(target.id, value);
          setContents(new Map(cache.current));
        }
      } catch {
        const cancelled = controller.signal.aborted;
        controller.abort();
        if (!cancelled) setError("上下文读取失败，请重新读取。");
      } finally {
        if (activeRead.current === controller) setReading(false);
      }
    },
    [call, taskId],
  );

  useEffect(() => {
    activeRead.current?.abort();
    if (generation.current !== list.generation) {
      generation.current = list.generation;
      cache.current.clear();
      setContents(new Map());
    }
    if (!selected || list.busy) {
      setReading(false);
      return;
    }
    const index = stream.findIndex((r) => r.id === selected.id);
    const previous = index > 0 ? stream[index - 1] : undefined;
    void readSequence([selected, ...(previous ? [previous] : [])]);
    return () => activeRead.current?.abort();
  }, [list.generation, list.busy, selected, stream, readSequence]);

  const inspected = useMemo(
    () =>
      stream.flatMap((r) => {
        const item = contents.get(r.id);
        return item ? [item] : [];
      }),
    [stream, contents],
  );
  return {
    ...list,
    selected,
    error: list.error ?? error,
    reading,
    inspected,
    content: list.selectedId ? (contents.get(list.selectedId) ?? null) : null,
    readHistory: () => readSequence(stream),
    cancelRead: () => {
      activeRead.current?.abort();
      setReading(false);
    },
  };
}
