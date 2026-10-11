import {
  type PluginInspectResponse,
  pluginInspectResponseSchema,
  pluginInstallResponseSchema,
} from "@kenfutwork/shared";
import type { IPluginManagementService } from "@zcode/services";
import { usePluginManagementStore } from "@zui/store/pluginManagementStore.js";
import {
  invalidatePluginInventoryReads,
  isCurrentPluginInventoryService,
} from "@zui/store/pluginManagementStoreLoading.js";
import { useCallback, useEffect, useRef, useState } from "react";

/** 原来源表单的宿主控制器；写入一次，未知响应只读库存对账。 */
export function usePluginSourceInstallation(options: {
  open: boolean;
  targetKey: string;
  service: IPluginManagementService;
  reconcile(): Promise<boolean>;
}) {
  const [inspection, setInspection] = useState<{
    source: string;
    result: PluginInspectResponse;
  } | null>(null);
  const [pending, setPending] = useState<"inspect" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const context = useRef({ ...options, epoch: 0 });
  const previous = context.current;
  const changed =
    previous.open !== options.open ||
    previous.targetKey !== options.targetKey ||
    previous.service !== options.service;
  context.current = { ...options, epoch: previous.epoch + (changed ? 1 : 0) };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (
      context.current.open !== options.open ||
      context.current.targetKey !== options.targetKey ||
      context.current.service !== options.service
    )
      return;
    setInspection(null);
    setPending(null);
    setError(null);
  }, [options.open, options.targetKey, options.service]);
  const guard = () => {
    const epoch = context.current.epoch;
    return () =>
      mounted.current &&
      context.current.service === options.service &&
      context.current.targetKey === options.targetKey &&
      context.current.open &&
      context.current.epoch === epoch;
  };
  const inventoryIsCurrent = () => {
    const state = usePluginManagementStore.getState();
    return (
      mounted.current &&
      context.current.service === options.service &&
      context.current.targetKey === options.targetKey &&
      isCurrentPluginInventoryService(options.service) &&
      (state.workspaceIdentity ?? state.workspacePath ?? "") ===
        options.targetKey &&
      state.configScope === "user"
    );
  };
  const invalidateSource = useCallback(() => {
    context.current.epoch += 1;
    setInspection(null);
    setError(null);
    setPending(null);
  }, []);

  async function inspect(source: string) {
    if (
      !options.open ||
      context.current.service !== options.service ||
      context.current.targetKey !== options.targetKey ||
      !options.service.inspectPluginSource
    )
      return;
    const current = guard();
    setPending("inspect");
    setError(null);
    try {
      const result = pluginInspectResponseSchema.safeParse(
        await options.service.inspectPluginSource({ url: source }),
      );
      if (!current()) return;
      if (!result.success) throw new Error("插件检查结果无效，请刷新页面。");
      setInspection({ source, result: result.data });
    } catch (cause) {
      if (current())
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current()) setPending(null);
    }
  }

  async function install(source: string): Promise<boolean> {
    if (
      !options.open ||
      !inventoryIsCurrent() ||
      pending ||
      !options.service.installPluginFromSource ||
      inspection?.source !== source ||
      !inspection.result.report.compatible
    )
      return false;
    const current = guard();
    setPending("install");
    setError(null);
    invalidatePluginInventoryReads();
    try {
      const raw = await options.service.installPluginFromSource({
        url: source,
        allowLifecycleScripts: false,
      });
      const result = pluginInstallResponseSchema.safeParse(raw);
      if (!result.success) throw new Error("插件安装结果未知，请刷新列表。");
      if (!inventoryIsCurrent()) return false;
      invalidatePluginInventoryReads();
      if (!(await options.reconcile()))
        throw new Error("插件已安装但列表读取失败，请刷新列表。");
      return current();
    } catch (cause) {
      if (!inventoryIsCurrent()) return false;
      invalidatePluginInventoryReads();
      await options.reconcile().catch(() => false);
      if (current())
        setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      if (current()) setPending(null);
    }
  }
  return { inspection, pending, error, inspect, install, invalidateSource };
}
