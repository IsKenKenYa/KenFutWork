import { Switch } from "@zui/components/ui/switch.js";
import { toast } from "@zui/components/ui/toast.js";
import {
  SettingsGroupCard,
  SettingsRow,
} from "@zui/settings/SettingsPageParts.js";
import { useEffect, useState } from "react";
import { surfaceJson } from "./surfaceApi.js";

/**
 * 实例模型行为设置（T4）：服务端 instance_settings 既有缝的界面入口。
 *
 * 「自动压缩」此前唯一 UI 在已退役的旧设置弹窗（workbench/settings-modal.tsx），
 * 服务端缝一直活着（run 时读 instance_settings.autoCompactEnabled 决定上下文
 * 自动压缩）；这里按 ZCode 设置行样式补建。实例设置无逐字段读写服务，一次
 * GET/PATCH 带全量回读——PATCH 是部分更新（只送改动字段），不会重置其它键。
 */
interface InstanceSettingsView {
  autoCompactEnabled: boolean;
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "保存失败";
}

export function InstanceModelSettings() {
  const [settings, setSettings] = useState<InstanceSettingsView | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{ settings: InstanceSettingsView }>("/api/instance/settings")
      .then((payload) => {
        if (!cancelled) setSettings(payload.settings);
      })
      .catch(() => {
        // 读不到保持关闭（宁严勿松）；开关只在读到现值后才可用
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async (next: boolean) => {
    if (!settings) return;
    setSettings({ ...settings, autoCompactEnabled: next });
    try {
      const payload = await surfaceJson<{
        settings: InstanceSettingsView;
      }>("/api/instance/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoCompactEnabled: next }),
      });
      setSettings(payload.settings);
    } catch (error) {
      setSettings((current) =>
        current ? { ...current, autoCompactEnabled: !next } : current,
      );
      toast(readableError(error));
    }
  };

  return (
    <section className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        模型行为
      </div>
      <SettingsGroupCard>
        <SettingsRow
          label="自动压缩"
          control={
            <Switch
              aria-label="自动压缩"
              checked={settings?.autoCompactEnabled ?? false}
              disabled={settings === null}
              onCheckedChange={(checked) => void toggle(checked)}
            />
          }
        />
      </SettingsGroupCard>
    </section>
  );
}
