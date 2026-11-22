import type { ReactNode } from "react";

/**
 * 空态容器：与设置页其它卡片同一张白卡（`bg-card`），边框保留虚线以示「这里还空着」。
 *
 * 用户口径 2026-11-22：设置页所有卡片都是白卡；透明底会让空态看起来像页面留白，
 * 与「没有找到子智能体」这块应有的卡片形状不符。
 */
const CONTAINER_CLASS_NAME =
  "rounded-xl border border-dashed border-border bg-card px-4 py-10 text-center";

export function PluginLoadingState({ label }: { label: string }) {
  return (
    <div
      className={`${CONTAINER_CLASS_NAME} text-ui-base text-foreground-subtle`}
    >
      {label}
    </div>
  );
}

export function PluginSearchEmptyState({ label }: { label: string }) {
  return (
    <div
      className={`${CONTAINER_CLASS_NAME} text-ui-base text-foreground-subtle`}
    >
      {label}
    </div>
  );
}

export function PluginInstallEmptyState({
  actions,
  description,
  title,
}: {
  actions: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 ${CONTAINER_CLASS_NAME}`}
    >
      <div className="space-y-1">
        <div className="text-ui-base font-medium text-foreground">{title}</div>
        <div className="text-ui-sm text-foreground-subtle">{description}</div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {actions}
      </div>
    </div>
  );
}
