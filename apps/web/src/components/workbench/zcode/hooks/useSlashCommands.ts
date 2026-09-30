/**
 * zcode 宿主适配：`@/hooks/useSlashCommands` 的数据源实现。
 * 来源：references/zcode/packages/ui/src/hooks/useSlashCommands.ts
 *
 * zcode 的 slash commands 来自 Agent 广播（zcodeSessionStore.workspace slashCommands）。
 * 本仓数据源 = 工作区设置的自定义命令（GET /api/workspace/settings → settings.commands，
 * 宿主 workbench 拉取后经 {@link injectWorkspaceSlashCommands} 注入；选中命令以
 * `/名字 args` 文本发送，宿主 onSubmit 里 expandCommand 展开为实际 prompt）。
 * 适配注记：导出签名与原文件一致；数据源由宿主注入（P5b 接线，替换原恒空 stub）。
 */
"use client";

import type { ZCodeSlashCommand } from "@zui/lib/zcode-shared";
import { useSyncExternalStore } from "react";

let injected: ZCodeSlashCommand[] = [];
const listeners = new Set<() => void>();
let version = 0;

/**
 * 宿主注入命令目录（workbench 拉到 workspace settings 后调用）。
 * 空数组 = 清空（`/` 面板的命令分组自动隐藏，不摆空壳）。
 */
export function injectWorkspaceSlashCommands(
  next: readonly ZCodeSlashCommand[],
): void {
  injected = [...next];
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSlashCommands(
  _workspacePath: string,
  _workspaceIdentity?: string,
): ZCodeSlashCommand[] {
  // 快照 = 注入版本号（触发重渲染）；列表本体读模块级最新值
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return injected;
}
