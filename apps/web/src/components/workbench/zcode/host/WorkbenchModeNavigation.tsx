import type { HostWorkbenchMode, HostWorkbenchNavigation } from "@zcode/shared";
import appLogoUrl from "@zui/assets/kenfutwork-mark.png";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
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
    <div className="px-2 pt-3 pb-0.5">
      <div
        role="radiogroup"
        aria-label="模式切换"
        className="flex items-center gap-0.5"
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
            className="flex min-h-[30px] min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 text-[13px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground data-[active=true]:font-medium data-[active=true]:text-foreground"
          >
            {item.icon}
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function HostWorkbenchModeNavigation({
  actions,
}: {
  /** 品牌行右侧的动作槽（如收起侧栏按钮）；按钮自带 no-drag，不破坏拖拽区。 */
  actions?: React.ReactNode;
}) {
  const navigation = useOptionalPlatform()?.workbenchNavigation;
  if (!navigation) return null;
  return (
    <ConnectedWorkbenchModeNavigation
      navigation={navigation}
      actions={actions}
    />
  );
}

function ConnectedWorkbenchModeNavigation({
  navigation,
  actions,
}: {
  navigation: HostWorkbenchNavigation;
  actions?: React.ReactNode;
}) {
  const snapshot = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
  );
  return (
    <div className="pb-2">
      {/* 品牌行（用户口径·参考图）：正常侧栏背景、裸黑 logo + 黑字标、等高紧凑，
          间距沿用原口径（px-3.5 / py-3 / gap-2）；无黑底条、无底片徽章。
          拖拽区仍由本行承接（原 h-12 空白拖拽条已去掉）。 */}
      <div className="flex w-full items-center gap-2 px-3.5 py-3 [app-region:drag]">
        {/* 黑标：品牌图为蓝色墨迹，brightness(0) 转黑；高度与 20px 字标的大写高一致。 */}
        {/* biome-ignore lint/performance/noImgElement: output: "export" 未开 images.unoptimized，next/image 会构建失败 */}
        <img
          src={appLogoUrl}
          alt="KenFutWork"
          className="h-[18px] w-auto brightness-0"
          draggable={false}
        />
        <span className="font-wordmark text-[20px] leading-none tracking-tight text-foreground">
          KenFutWork
        </span>
        {actions ? (
          <div className="ml-auto flex items-center [app-region:no-drag]">
            {actions}
          </div>
        ) : null}
      </div>
      <WorkbenchModeNavigation {...snapshot} onModeChange={navigation.open} />
    </div>
  );
}
