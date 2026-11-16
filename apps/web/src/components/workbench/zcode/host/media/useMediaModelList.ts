import { ApiAccessError, ApiApplicationError } from "@kenfutwork/shared";
import { useCallback, useEffect, useRef, useState } from "react";

export type MediaModelListState<Model> =
  | { status: "loading" }
  | { status: "ready"; models: Model[] }
  | { status: "error"; message: string };

const emptyModels: never[] = [];
const loading = { status: "loading" } as const;

function publicModelListError(error: unknown): string {
  if (error instanceof ApiAccessError) return error.message;
  if (error instanceof ApiApplicationError) {
    if (error.status === 401) return new ApiAccessError().message;
    if (error.message.trim()) return error.message;
  }
  return "模型列表读取失败，请重新读取。";
}

export function useMediaModelList<Model>(
  load: (signal?: AbortSignal) => Promise<{ models: Model[] }>,
  enabled = true,
) {
  const [state, setState] = useState<MediaModelListState<Model>>(loading);
  const activeRead = useRef<AbortController | null>(null);

  const reload = useCallback(() => {
    activeRead.current?.abort();
    const controller = new AbortController();
    activeRead.current = controller;
    setState(loading);
    async function read() {
      try {
        const { models } = await load(controller.signal);
        if (!Array.isArray(models)) throw new Error("模型列表格式有误");
        if (!controller.signal.aborted) setState({ status: "ready", models });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({ status: "error", message: publicModelListError(error) });
      }
    }
    void read();
  }, [load]);

  useEffect(() => {
    if (!enabled) return;
    reload();
    return () => activeRead.current?.abort();
  }, [enabled, reload]);

  return {
    state,
    models: state.status === "ready" ? state.models : emptyModels,
    reload,
  };
}
