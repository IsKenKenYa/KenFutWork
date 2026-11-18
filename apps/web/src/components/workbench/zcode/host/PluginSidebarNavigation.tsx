import { createPluginIconResourceReference } from "@kenfutwork/shared";
import type { HostPluginSidebarEntry } from "@zcode/shared";
import { PluginIcon } from "@zui/components/PluginIcon.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SidebarNavButton } from "./SidebarNavButton.js";

/**
 * 只扩展原侧栏导航槽，沿用原 Button 和 PluginIcon。
 * `collapsed` = 收起态 rail：同一批入口只剩图标，不能因为侧栏收起就整个消失。
 */
export function PluginSidebarNavigation({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const sidebar = useOptionalPlatform()?.pluginSidebar;
  const [entries, setEntries] = useState<HostPluginSidebarEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const retry = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!sidebar) return;
    let active = true;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void sidebar
        .read()
        .then((result) => {
          if (!active || current !== generation) return;
          setEntries(result);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!active || current !== generation) return;
          setEntries([]);
          setError(cause instanceof Error ? cause.message : "插件入口读取失败");
        });
    };
    const release = sidebar.subscribe(refresh);
    retry.current = refresh;
    refresh();
    return () => {
      active = false;
      retry.current = null;
      release();
    };
  }, [sidebar]);
  return (
    <>
      {error ? (
        <SidebarNavButton
          collapsed={collapsed}
          icon={<RotateCw className="size-4" />}
          label="重试插件入口"
          hint={error}
          onClick={() => retry.current?.()}
        />
      ) : null}
      {entries.map((entry) => {
        const resource = entry.icon
          ? createPluginIconResourceReference(entry.pluginId, entry.icon)
          : undefined;
        return (
          <SidebarNavButton
            key={entry.id}
            collapsed={collapsed}
            icon={
              <PluginIcon
                monochrome
                pluginId={entry.pluginId}
                {...(resource ? { src: resource } : {})}
                className="size-4 rounded-none bg-transparent"
              />
            }
            label={entry.title}
            onClick={() => sidebar?.open(entry)}
          />
        );
      })}
    </>
  );
}
