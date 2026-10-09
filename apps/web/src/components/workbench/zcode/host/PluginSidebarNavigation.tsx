import { createPluginIconResourceReference } from "@kenfutwork/shared";
import type { HostPluginSidebarEntry } from "@zcode/shared";
import { PluginIcon } from "@zui/components/PluginIcon.js";
import { Button } from "@zui/components/ui/button.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { useEffect, useRef, useState } from "react";

/** 只扩展原侧栏导航槽，沿用原 Button 和 PluginIcon。 */
export function PluginSidebarNavigation() {
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
        <Button
          variant="ghost"
          size="lg"
          title={error}
          onClick={() => retry.current?.()}
        >
          重试插件入口
        </Button>
      ) : null}
      {entries.map((entry) => {
        const resource = entry.icon
          ? createPluginIconResourceReference(entry.pluginId, entry.icon)
          : undefined;
        return (
          <Button
            key={entry.id}
            variant="ghost"
            size="lg"
            data-icon="inline-start"
            className="w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground"
            onClick={() => sidebar?.open(entry)}
          >
            <PluginIcon
              pluginId={entry.pluginId}
              {...(resource ? { src: resource } : {})}
              className="size-4 rounded-none bg-transparent"
            />
            {entry.title}
          </Button>
        );
      })}
    </>
  );
}
