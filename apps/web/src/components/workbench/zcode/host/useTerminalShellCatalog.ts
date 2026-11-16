import {
  ApiAccessError,
  ApiApplicationError,
  codeShellsResponseSchema,
} from "@kenfutwork/shared";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { surfaceJson } from "./surfaceApi.js";

type TerminalShellCatalog = ReturnType<typeof codeShellsResponseSchema.parse>;

export type TerminalShellRead =
  | { status: "loading" }
  | { status: "ready"; catalog: TerminalShellCatalog }
  | { status: "error"; message: string; retrying: boolean };

const loading: TerminalShellRead = { status: "loading" };

export function useTerminalShellCatalog(enabled: boolean) {
  const [read, setRead] = useState<TerminalShellRead>(loading);
  const request = useRef<AbortController | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const retryOrigin = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(() => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    void surfaceJson<unknown>("/api/code/shells", { signal })
      .then((payload) => {
        if (signal.aborted) return;
        const catalog = codeShellsResponseSchema.parse(payload);
        setRead({ status: "ready", catalog });
      })
      .catch((failure: unknown) => {
        if (signal.aborted) return;
        setRead({
          status: "error",
          message:
            failure instanceof ApiApplicationError && failure.status === 401
              ? new ApiAccessError().message
              : "无法读取 Shell 列表",
          retrying: false,
        });
      })
      .finally(() => {
        if (request.current === controller) request.current = null;
      });
  }, []);

  useEffect(() => {
    if (!enabled) {
      retryOrigin.current = null;
      setRead(loading);
      return;
    }
    load();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [enabled, load]);

  function retry(button: HTMLButtonElement) {
    if (!enabled || read.status !== "error" || request.current) return;
    retryOrigin.current =
      button.ownerDocument.activeElement === button ? button : null;
    setRead({ ...read, retrying: true });
    load();
  }

  useLayoutEffect(() => {
    if (read.status !== "ready" || !retryOrigin.current) return;
    const button = retryOrigin.current;
    retryOrigin.current = null;
    const { activeElement, body } = button.ownerDocument;
    // 重试按钮已移除；只有焦点仍在原处时才转交给恢复后的菜单。
    if (activeElement === button || activeElement === body)
      menuTriggerRef.current?.focus();
  }, [read.status]);

  return { read, retry, menuTriggerRef };
}
