"use client";

import type { InstanceSettings } from "@kenfutwork/shared";
import { useCallback, useMemo } from "react";
import {
  type AgentGovernanceSettings,
  selectAgentGovernanceSettings,
} from "@/lib/agent-governance-settings";
import {
  type SaveInstanceSettings,
  useInstanceSettings,
} from "@/lib/use-instance-settings";
import { AgentGovernanceSection } from "./agent-governance-section";
import { Button } from "./ui/button";
import { ListError, ListLoading } from "./workbench/list-state";

/** Design 与 Code 共用这一处治理选择/部分保存；不另建配置或再次 GET。 */
export function AgentGovernanceSettingsView({
  settings,
  save,
}: {
  settings: InstanceSettings;
  save: SaveInstanceSettings;
}) {
  const initial = useMemo(
    () => selectAgentGovernanceSettings(settings),
    [settings],
  );
  const onSave = useCallback(
    async (next: AgentGovernanceSettings) => {
      const saved = await save(next);
      if (!saved) throw new Error("设置页面已变化，请重新加载后保存。");
    },
    [save],
  );
  return <AgentGovernanceSection initial={initial} onSave={onSave} />;
}

/** Code 已有实例弹窗的治理内容；首个成功响应之前只显示加载或错误。 */
export function AgentGovernanceSettingsPanel({
  enabled,
}: {
  enabled: boolean;
}) {
  const settings = useInstanceSettings(enabled, null);
  if (!enabled) return null;
  if (settings.status === "loading")
    return <ListLoading label="正在加载 Agent 治理设置…" rows={2} />;
  if (settings.error)
    return (
      <div className="space-y-3">
        <ListError message={settings.error} />
        <Button
          type="button"
          variant="outline"
          onClick={() => void settings.reload()}
        >
          重新加载
        </Button>
      </div>
    );
  if (!settings.settings) return null;
  return (
    <AgentGovernanceSettingsView
      settings={settings.settings}
      save={settings.save}
    />
  );
}
