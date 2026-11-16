import {
  BROWSER_OPEN_TARGET_KEY,
  type BrowserOpenTarget,
  browserOpenTargetError,
  readBrowserOpenTarget,
  writeBrowserOpenTarget,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useState } from "react";

export function useBrowserOpenTarget() {
  const [value, setValue] = useState<BrowserOpenTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    try {
      setValue(readBrowserOpenTarget(window.localStorage));
      setError(null);
    } catch (cause) {
      setValue(null);
      setError(browserOpenTargetError(cause, "read"));
    }
  }, []);
  useEffect(() => {
    reload();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === BROWSER_OPEN_TARGET_KEY) reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reload]);
  const save = (next: BrowserOpenTarget) => {
    try {
      writeBrowserOpenTarget(window.localStorage, next);
      setValue(next);
      setError(null);
    } catch (cause) {
      setError(browserOpenTargetError(cause, "save"));
    }
  };
  return { value, error, save, reload };
}
