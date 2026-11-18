"use client";

import type { InstanceSettings } from "@kenfutwork/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectAgentGovernanceSettings } from "./agent-governance-settings";
import { getServerBaseUrl } from "./env";
import { fetchInstanceSettings, updateInstanceSettings } from "./server-api";

type RequestScope = { enabled: boolean; accessToken: string | null };
type SettingsStatus = "idle" | "loading" | "ready" | "error";
type SettingsSnapshot = {
  scope: RequestScope;
  status: SettingsStatus;
  settings: InstanceSettings | null;
  error: string | null;
};
export type SaveInstanceSettings = (
  patch: Partial<InstanceSettings>,
) => Promise<InstanceSettings | null>;

// 只持有传输写屏障，不缓存设置或凭据；跨关闭/重新挂载的读取也等待已发送写入。
const settingWriteTails = new Map<string, Promise<void>>();

function enqueueSettingsWrite<T>(
  endpoint: string,
  operation: () => Promise<T>,
) {
  const previous = settingWriteTails.get(endpoint) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(
    () => {},
    () => {},
  );
  settingWriteTails.set(endpoint, settled);
  void settled.then(() => {
    if (settingWriteTails.get(endpoint) === settled)
      settingWriteTails.delete(endpoint);
  });
  return result;
}

/** 实例读写共用写屏障；展示scope与读序号不充当后端写入版本。 */
export function useInstanceSettings(
  enabled: boolean,
  accessToken: string | null,
) {
  const scope = useMemo(
    () => ({ enabled, accessToken }),
    [enabled, accessToken],
  );
  const currentScope = useRef<RequestScope | null>(scope);
  currentScope.current = scope;
  const endpoint = getServerBaseUrl();
  const readSequence = useRef(0);
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>({
    scope,
    status: "loading",
    settings: null,
    error: null,
  });
  const isCurrentScope = useCallback(
    () => currentScope.current === scope && scope.enabled,
    [scope],
  );
  const isCurrentRead = useCallback(
    (sequence: number) => isCurrentScope() && readSequence.current === sequence,
    [isCurrentScope],
  );
  const reload = useCallback(async () => {
    if (!scope.enabled || currentScope.current !== scope) return;
    const sequence = ++readSequence.current;
    setSnapshot({ scope, status: "loading", settings: null, error: null });
    try {
      await settingWriteTails.get(endpoint);
      if (!isCurrentRead(sequence)) return;
      const { settings } = await fetchInstanceSettings(scope.accessToken);
      selectAgentGovernanceSettings(settings);
      if (isCurrentRead(sequence))
        setSnapshot({ scope, status: "ready", settings, error: null });
    } catch (error) {
      if (isCurrentRead(sequence))
        setSnapshot({
          scope,
          status: "error",
          settings: null,
          error: error instanceof Error ? error.message : "设置加载失败。",
        });
    }
  }, [endpoint, isCurrentRead, scope]);
  const save = useCallback<SaveInstanceSettings>(
    async (patch) => {
      if (!isCurrentScope()) return null;
      readSequence.current += 1;
      try {
        const settings = await enqueueSettingsWrite(endpoint, async () => {
          // 已发送写入继续完成；关闭或换凭据后尚未发送的旧操作不再派发。
          if (!isCurrentScope()) return null;
          const result = await updateInstanceSettings(scope.accessToken, patch);
          selectAgentGovernanceSettings(result.settings);
          return result.settings;
        });
        if (!settings || !isCurrentScope()) return null;
        setSnapshot({ scope, status: "ready", settings, error: null });
        return settings;
      } catch (error) {
        if (!isCurrentScope()) return null;
        throw error;
      }
    },
    [endpoint, isCurrentScope, scope],
  );
  useEffect(() => {
    currentScope.current = scope;
    void reload();
    return () => {
      if (currentScope.current === scope) currentScope.current = null;
      readSequence.current += 1;
    };
  }, [reload, scope]);
  const visible = enabled && snapshot.scope === scope;
  return {
    status: visible ? snapshot.status : enabled ? "loading" : "idle",
    settings: visible ? snapshot.settings : null,
    error: visible ? snapshot.error : null,
    reload,
    save,
  };
}
