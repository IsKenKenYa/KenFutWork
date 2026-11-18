import {
  OPEN_DESIGN_PLUGIN_BUNDLE_NAME,
  type OpenDesignEntry,
  type OpenDesignHostStatusResponse,
  resolveOpenDesignEntry,
} from "@kenfutwork/shared";
import { useEffect, useSyncExternalStore } from "react";
import { surfaceJson } from "./surfaceApi.js";

/**
 * OpenDesign 右侧栏入口的门控（**壳内**）。
 *
 * 为什么不在 `@/hooks`：右侧栏与启动卡都住在 code-ui 壳里（iframe 中的 zcode 包），
 * 它只经 `surfaceApi` 直接打宿主 HTTP，拿不到外层 Next.js 的 `@/hooks`
 * （`useFlowHostEntry` 的消费方是外层 `workbench.tsx`，两者不是同一层）。
 *
 * 两路探针（插件安装态 + 宿主就绪）**都落定后一次性发布**：中途的「插件已答、状态未答」
 * 会被判定函数读成不可用，入口一闪就没（flow 模式真机踩过）。
 */
let snapshot: OpenDesignEntry | null = null;
let readGeneration = 0;
const listeners = new Set<() => void>();

function publish(next: OpenDesignEntry | null) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function readPluginInstallState(): Promise<{
  installed: boolean;
  enabled: boolean;
}> {
  try {
    const data = await surfaceJson<{
      plugins?: Array<{ name: string; installed: boolean; enabled: boolean }>;
    }>("/api/plugins");
    const matches =
      data.plugins?.filter(
        (candidate) => candidate.name === OPEN_DESIGN_PLUGIN_BUNDLE_NAME,
      ) ?? [];
    return {
      installed: matches.some((candidate) => candidate.installed === true),
      enabled: matches.some(
        (candidate) =>
          candidate.installed === true && candidate.enabled === true,
      ),
    };
  } catch {
    return { installed: false, enabled: false };
  }
}

async function readHostStatus(): Promise<OpenDesignHostStatusResponse | null> {
  try {
    return await surfaceJson<OpenDesignHostStatusResponse>(
      "/api/open-design/host/status",
    );
  } catch {
    return null;
  }
}

/** 重新探活并发布（两路都落定后才写快照）。 */
export async function refreshOpenDesignEntry(): Promise<void> {
  const generation = ++readGeneration;
  const [plugin, status] = await Promise.all([
    readPluginInstallState(),
    readHostStatus(),
  ]);
  if (generation !== readGeneration) return;
  publish(
    resolveOpenDesignEntry({
      pluginInstalled: plugin.installed,
      pluginEnabled: plugin.enabled,
      status,
    }),
  );
}

/**
 * 入口状态。`null` = 两路探针尚未全部落定——调用方先不渲染入口也不报错
 * （与 flow 的发布纪律一致）。
 */
export function useOpenDesignEntry(): OpenDesignEntry | null {
  useEffect(() => {
    void refreshOpenDesignEntry();
  }, []);
  return useSyncExternalStore(subscribe, () => snapshot);
}
