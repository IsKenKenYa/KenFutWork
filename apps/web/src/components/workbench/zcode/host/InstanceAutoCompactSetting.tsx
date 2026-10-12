import { Switch } from "@zui/components/ui/switch.js";
import { toast } from "@zui/components/ui/toast.js";
import {
  SettingsGroupCard,
  SettingsRow,
} from "@zui/settings/SettingsPageParts.js";
import { useEffect, useState } from "react";
import { surfaceJson } from "./surfaceApi.js";

/**
 * 上下文自动压缩开关（宿主件，T4）。
 *
 * 数据面是服务端实例设置缝：GET/PATCH `/api/instance/settings` 的
 * `autoCompactEnabled`（instance_settings，agent 运行时消费）——与旧设置弹窗
 * 「模型」页同一字段，不造第二份真相。写法沿用旧页口径：先写库、失败回滚。
 */
export function HostInstanceAutoCompactSetting() {
  // null = 读取中；schema 默认值为 true，读取前按默认展示但禁用交互
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{ settings: { autoCompactEnabled: boolean } }>(
      "/api/instance/settings",
    )
      .then((payload) => {
        if (!cancelled) setEnabled(payload.settings.autoCompactEnabled);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    try {
      const payload = await surfaceJson<{
        settings: { autoCompactEnabled: boolean };
      }>("/api/instance/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoCompactEnabled: next }),
      });
      setEnabled(payload.settings.autoCompactEnabled);
    } catch (error) {
      setEnabled(previous);
      toast(
        error instanceof Error && error.message ? error.message : "保存失败",
      );
    }
  };

  return (
    <SettingsGroupCard>
      <SettingsRow
        label="上下文自动压缩"
        control={
          <Switch
            aria-label="上下文自动压缩"
            checked={enabled ?? true}
            disabled={enabled === null}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        }
        detail={
          failed ? (
            <div className="text-ui-base text-foreground-subtle">读取失败</div>
          ) : undefined
        }
      />
    </SettingsGroupCard>
  );
}
