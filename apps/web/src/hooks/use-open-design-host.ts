"use client";

import {
  OPEN_DESIGN_PLUGIN_BUNDLE_NAME,
  type OpenDesignEntry,
  type OpenDesignHostStatusResponse,
  resolveOpenDesignEntry,
} from "@kenfutwork/shared";
import { usePluginHostEntry } from "@/hooks/use-plugin-host-entry";

/**
 * OpenDesign 右侧栏入口的接线层：插件安装态 + 宿主适配层探针 → `resolveOpenDesignEntry`。
 *
 * 与 flow 不同的是它的宿主状态带一次真实可达性探测（承载是独立服务，配了地址不等于服务活着），
 * 所以「未就绪」的原因可能来自配置缺失，也可能来自服务不通——两者都由判定函数如实透出。
 */
export function useOpenDesignHostEntry(enabled = true): {
  entry: OpenDesignEntry | null;
  refresh: () => void;
} {
  return usePluginHostEntry<OpenDesignHostStatusResponse, OpenDesignEntry>({
    enabled,
    bundleName: OPEN_DESIGN_PLUGIN_BUNDLE_NAME,
    statusPath: "/api/open-design/host/status",
    resolve: resolveOpenDesignEntry,
  });
}
