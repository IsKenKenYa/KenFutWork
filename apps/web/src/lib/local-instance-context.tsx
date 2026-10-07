"use client";

import type { InstanceContext } from "@kenfutwork/shared";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  LOCAL_ACCESS_LOST_EVENT,
  LocalAccessError,
  loadLocalInstance,
} from "./local-access";

export type LocalInstanceState =
  | { status: "loading"; instance: null; message: null }
  | { status: "ready"; instance: InstanceContext; message: null }
  | { status: "disconnected" | "error"; instance: null; message: string };

type LocalInstanceContextValue = LocalInstanceState & { retry: () => void };
const LocalInstanceContext = createContext<LocalInstanceContextValue | null>(
  null,
);

export function LocalInstanceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LocalInstanceState>({
    status: "loading",
    instance: null,
    message: null,
  });
  const generation = useRef(0);
  const retry = useCallback(() => {
    const attempt = ++generation.current;
    setState({ status: "loading", instance: null, message: null });
    void loadLocalInstance().then(
      (instance) => {
        if (attempt === generation.current)
          setState({ status: "ready", instance, message: null });
      },
      (error: unknown) => {
        if (attempt !== generation.current) return;
        setState({
          status:
            error instanceof LocalAccessError &&
            (error.status === 401 || error.status === 403)
              ? "disconnected"
              : "error",
          instance: null,
          message: error instanceof Error ? error.message : "本机服务不可用。",
        });
      },
    );
  }, []);
  useEffect(() => {
    const disconnected = () => {
      generation.current += 1;
      setState({
        status: "disconnected",
        instance: null,
        message: "本机连接已失效，请从桌面重新打开。",
      });
    };
    window.addEventListener(LOCAL_ACCESS_LOST_EVENT, disconnected);
    retry();
    return () => {
      generation.current += 1;
      window.removeEventListener(LOCAL_ACCESS_LOST_EVENT, disconnected);
    };
  }, [retry]);
  return (
    <LocalInstanceContext.Provider value={{ ...state, retry }}>
      {children}
    </LocalInstanceContext.Provider>
  );
}

export function useLocalInstance(): LocalInstanceContextValue {
  const context = useContext(LocalInstanceContext);
  if (!context)
    throw new Error(
      "useLocalInstance must be used within LocalInstanceProvider",
    );
  return context;
}

export function LocalInstanceBoundary({ children }: { children: ReactNode }) {
  const { status, message, retry } = useLocalInstance();
  if (status === "ready") return children;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <section className="max-w-md space-y-4 text-center" aria-live="polite">
        <h1 className="text-lg font-medium">
          {status === "loading"
            ? "正在连接本机实例…"
            : status === "disconnected"
              ? "连接本机工作台"
              : "本机服务不可用"}
        </h1>
        {status === "disconnected" ? (
          <p className="text-sm text-muted-foreground">
            请启动 KenFutWork 桌面应用，选择“在浏览器打开”以连接此实例。
          </p>
        ) : null}
        {message ? (
          <p role="status" className="text-sm text-muted-foreground">
            {message}
          </p>
        ) : null}
        {status !== "loading" ? (
          <button
            type="button"
            onClick={retry}
            className="rounded-md border px-4 py-2 text-sm"
          >
            重新连接
          </button>
        ) : null}
      </section>
    </main>
  );
}
