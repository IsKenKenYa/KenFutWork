import type { HostWorkbenchMode, HostWorkbenchNavigation } from "@zcode/shared";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { WindowsTopLeftLogo } from "@zui/WindowsTopLeftLogo.js";
import { Code2, Palette, Workflow } from "lucide-react";
import { useSyncExternalStore } from "react";

/** 从CanvasSidebar原横排及收起按钮提取，Code／Design／Flow共用展示。 */
export function WorkbenchModeNavigation({
  mode,
  availableModes,
  onModeChange,
  collapsed = false,
}: {
  mode: HostWorkbenchMode;
  availableModes: readonly HostWorkbenchMode[];
  onModeChange: (mode: HostWorkbenchMode) => void;
  collapsed?: boolean;
}) {
  const modeItems = availableModes.map((id) => ({
    id,
    label: id === "code" ? "Code" : id === "design" ? "Design" : "Flow",
    icon:
      id === "code" ? (
        <Code2 className="h-4 w-4 shrink-0" />
      ) : id === "design" ? (
        <Palette className="h-4 w-4 shrink-0" />
      ) : (
        <Workflow className="h-4 w-4 shrink-0" />
      ),
  }));
  if (collapsed)
    return (
      <>
        {modeItems.map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.label}
            aria-label={item.label}
            data-active={mode === item.id}
            onClick={() => onModeChange(item.id)}
            className="rounded-md p-2 hover:bg-muted data-[active=true]:bg-muted data-[active=true]:text-foreground data-[active=false]:text-muted-foreground"
          >
            {item.icon}
          </button>
        ))}
      </>
    );
  return (
    <div className="px-2 pt-1 pb-0.5">
      <div
        role="radiogroup"
        aria-label="模式切换"
        className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
      >
        {modeItems.map((item) => (
          // biome-ignore lint/a11y/useSemanticElements: 提取现有分段radio按钮，保持图标和布局
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={mode === item.id}
            data-active={mode === item.id}
            onClick={() => onModeChange(item.id)}
            className="flex min-h-[30px] min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 text-[13px] whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:text-foreground data-[active=true]:shadow-sm"
          >
            {item.icon}
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function HostWorkbenchModeNavigation() {
  const navigation = useOptionalPlatform()?.workbenchNavigation;
  if (!navigation) return null;
  return <ConnectedWorkbenchModeNavigation navigation={navigation} />;
}

function ConnectedWorkbenchModeNavigation({
  navigation,
}: {
  navigation: HostWorkbenchNavigation;
}) {
  const snapshot = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
  );
  return (
    <div className="pb-2">
      <div className="flex items-center gap-[5px] px-4 pt-3 pb-2">
        <WindowsTopLeftLogo
          className="static m-0 h-auto p-0"
          imageClassName="h-[15px] w-auto"
        />
        <span
          className="font-wordmark bg-clip-text text-xl tracking-tight text-transparent"
          style={{ backgroundImage: "var(--wordmark-gradient)" }}
        >
          KenFutWork
        </span>
      </div>
      <WorkbenchModeNavigation {...snapshot} onModeChange={navigation.open} />
    </div>
  );
}
