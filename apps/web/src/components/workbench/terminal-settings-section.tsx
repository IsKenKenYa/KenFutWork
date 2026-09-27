"use client";

import type { TerminalShellId } from "@kenfutwork/shared";
import { useCallback, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ListLoading } from "@/components/workbench/list-state";
import { fetchTerminalShells } from "@/lib/code-git-api";
import {
  fetchWorkspaceSettings,
  updateWorkspaceSettings,
} from "@/lib/server-api";
import {
  SETTINGS_CONTROL_WIDTH,
  SETTINGS_ROW,
  SETTINGS_ROW_STACK,
  SETTINGS_TITLE,
} from "@/lib/settings-layout";

/**
 * 设置 → 通用 → 终端：右栏「终端」标签默认用哪个 shell（用户口径：「终端应该是直连 cmd 或者
 * powershell、git-bash 等等，可以在设置里配置默认的」）。
 *
 * 两条边界如实写在界面上：
 * - `auto` 是**按平台取默认**（Windows → cmd，POSIX → sh），不是「随便挑一个」；
 * - 清单是**本机探测**出来的（换台机器可能没有 PowerShell 7），设置里选了本机没有的 shell 时
 *   服务端会落回平台默认——所以这里只列**探测到的**，另加一条 `auto`。
 */
export function TerminalSettingsSection({
  accessToken,
}: {
  accessToken: string;
}) {
  const [shells, setShells] = useState<
    Array<{ id: TerminalShellId; label: string; executable: string }>
  >([]);
  const [shell, setShell] = useState<TerminalShellId>("auto");
  /** `auto` 在本机解析成谁（选项里写清「auto → cmd」）。 */
  const [autoShell, setAutoShell] = useState<TerminalShellId | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, settings] = await Promise.all([
        fetchTerminalShells(accessToken),
        fetchWorkspaceSettings(accessToken),
      ]);
      setShells(list.shells);
      setAutoShell(list.resolvedShell);
      setShell(settings.settings.terminalShell);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "无法读取终端设置。");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleChange = async (next: TerminalShellId) => {
    setSaving(true);
    setMessage(null);
    try {
      await updateWorkspaceSettings(accessToken, { terminalShell: next });
      setShell(next);
      setMessage("已保存，下次执行时生效。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <ListLoading label="正在读取终端设置…" rows={1} />;

  return (
    <section className={SETTINGS_ROW_STACK}>
      <h3 className={SETTINGS_TITLE}>终端</h3>
      {/*
        一个配置项 = 一行：标签在左、控件靠右。这里用 div + 可见文字 + 触发器上的 aria-label，
        而不是像浏览器页那样把 Select 包进 <label>（那需要 biome-ignore 压制 noLabelWithoutControl）。
        原先只有控件、没有可见标签，光看界面不知道这个下拉是干什么的。
      */}
      <div className={`${SETTINGS_ROW} justify-between`}>
        <span className="flex items-center gap-2">
          <span>默认 shell</span>
          {saving ? (
            <span className="text-xs text-muted-foreground">保存中…</span>
          ) : null}
        </span>
        <Select
          aria-label="默认 shell"
          value={shell}
          onValueChange={(next) => {
            if (typeof next === "string" && next !== shell) {
              void handleChange(next as TerminalShellId);
            }
          }}
          items={[
            {
              value: "auto",
              label: autoShell ? `自动（${autoShell}）` : "自动",
            },
            ...shells.map((option) => ({
              value: option.id,
              label: option.label,
            })),
          ]}
        >
          <SelectTrigger
            className={SETTINGS_CONTROL_WIDTH}
            aria-label="默认 shell"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-56">
            <SelectItem value="auto">
              {autoShell ? `自动（${autoShell}）` : "自动"}
            </SelectItem>
            {shells.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {message ? (
        <p className="text-xs text-muted-foreground">{message}</p>
      ) : null}
    </section>
  );
}
