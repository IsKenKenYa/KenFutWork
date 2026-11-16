import { ApiAccessError, ApiApplicationError } from "@kenfutwork/shared";
import { useCallback, useEffect, useState } from "react";

export function readableSurfaceError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiApplicationError)) return fallback;
  if (error.status === 401) return new ApiAccessError().message;
  if (error.code === "application_error" && (error.status ?? 0) >= 500)
    return fallback;
  return error.message;
}

export type SurfaceReadState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

/** 路径或读取次数改变后，只允许本次请求更新当前页面。 */
export function useSurfaceRead<T>(
  path: string | null,
  read: (path: string, signal: AbortSignal) => Promise<T>,
  fallback: string,
) {
  const [result, setResult] = useState<{
    path: string;
    attempt: number;
    state: Exclude<SurfaceReadState<T>, { status: "loading" }>;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    const { signal } = controller;
    void read(path, signal).then(
      (value) => {
        if (!signal.aborted)
          setResult({ path, attempt, state: { status: "ready", value } });
      },
      (failure: unknown) => {
        if (!signal.aborted)
          setResult({
            path,
            attempt,
            state: {
              status: "error",
              message: readableSurfaceError(failure, fallback),
            },
          });
      },
    );
    return () => controller.abort();
  }, [path, attempt, read, fallback]);
  const state: SurfaceReadState<T> =
    path && result?.path === path && result.attempt === attempt
      ? result.state
      : { status: "loading" };
  return { state, reload };
}
