import { ApiApplicationError } from "@kenfutwork/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { surfaceJson } from "./surfaceApi.js";

export interface BrowserPermissionView {
  browserControlEnabled: boolean;
  browserAutoScreenshot: boolean;
  browserHeadless: boolean;
  browserDevtoolsReadEnabled: boolean;
  browserEvalEnabled: boolean;
}

type CdpStatus =
  | { status: "disconnected" }
  | { status: "connecting" }
  | {
      status: "connected";
      browser: string;
      tabs: number;
      currentUrl: string;
      headless: boolean;
    }
  | { status: "error"; message: string };

type Resource = "permissions" | "cdp";
interface BrowserSettingsState {
  flags: BrowserPermissionView | null;
  cdp: CdpStatus | null;
  reading: boolean;
  saving: Resource | null;
  errors: Record<Resource, string | null>;
}

function readableError(error: unknown, message: string) {
  return error instanceof ApiApplicationError && error.message.trim()
    ? error.message
    : message;
}

function useBrowserSettingsRead() {
  const [state, setState] = useState<BrowserSettingsState>({
    flags: null,
    cdp: null,
    reading: true,
    saving: null,
    errors: { permissions: null, cdp: null },
  });
  const active = useRef(false);
  const currentRead = useRef<AbortController | null>(null);
  const reload = useCallback(() => {
    if (active.current) return;
    const controller = new AbortController();
    currentRead.current = controller;
    active.current = true;
    setState((current) => ({
      ...current,
      reading: true,
      errors: { permissions: null, cdp: null },
    }));
    void Promise.allSettled([
      surfaceJson<BrowserPermissionView>("/api/permissions/tier", {
        signal: controller.signal,
      }),
      surfaceJson<{ cdp: CdpStatus }>("/api/browser/cdp/status", {
        signal: controller.signal,
      }),
    ]).then(([permissions, browser]) => {
      if (controller.signal.aborted) return;
      active.current = false;
      setState((current) => ({
        ...current,
        reading: false,
        flags: permissions.status === "fulfilled" ? permissions.value : null,
        cdp: browser.status === "fulfilled" ? browser.value.cdp : null,
        errors: {
          permissions:
            permissions.status === "fulfilled"
              ? null
              : readableError(
                  permissions.reason,
                  "浏览器设置读取失败，请重新读取。",
                ),
          cdp:
            browser.status === "fulfilled"
              ? null
              : readableError(browser.reason, "连接状态读取失败，请重新读取。"),
        },
      }));
    });
  }, []);
  useEffect(() => {
    reload();
    return () => {
      currentRead.current?.abort();
      active.current = false;
    };
  }, [reload]);
  return {
    state,
    setState,
    active,
    reload,
  };
}

/** 读取与保存共用在途标记，整份旧响应不能覆盖后一次设置。 */
export function useBrowserSettingsState() {
  const { state, setState, active, reload } = useBrowserSettingsRead();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const perform = async (
    resource: Resource,
    message: string,
    operation: () => Promise<void>,
  ) => {
    if (active.current || !mounted.current) return;
    active.current = true;
    setState((current) => ({
      ...current,
      saving: resource,
      errors: { ...current.errors, [resource]: null },
    }));
    try {
      await operation();
    } catch (error) {
      if (mounted.current)
        setState((current) => ({
          ...current,
          errors: {
            ...current.errors,
            [resource]: readableError(error, message),
          },
        }));
    } finally {
      active.current = false;
      if (mounted.current)
        setState((current) => ({ ...current, saving: null }));
    }
  };
  const toggleFlag = (key: keyof BrowserPermissionView, next: boolean) => {
    if (!state.flags) return Promise.resolve();
    return perform(
      "permissions",
      "浏览器设置保存失败，请重新读取后确认。",
      async () => {
        const flags = await surfaceJson<BrowserPermissionView>(
          "/api/permissions/tier",
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ [key]: next }),
          },
        );
        if (mounted.current) setState((current) => ({ ...current, flags }));
      },
    );
  };
  const changeConnection = (action: "connect" | "disconnect") =>
    perform("cdp", "连接结果待确认，请重新读取状态。", async () => {
      const { cdp } = await surfaceJson<{ cdp: CdpStatus }>(
        `/api/browser/cdp/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      if (mounted.current) setState((current) => ({ ...current, cdp }));
    });
  return {
    ...state,
    busy: state.reading || state.saving !== null,
    reload,
    toggleFlag,
    connectCdp: () => changeConnection("connect"),
    disconnectCdp: () => changeConnection("disconnect"),
  };
}
