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
    <div className="px-2 pt-3 pb-0.5">
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
      {/* 品牌行（启动首屏即见）：黑底白标、铺满侧栏宽度、贴窗口顶——
          同时承接标题栏拖拽区（原 h-12 空白拖拽条已按用户口径去掉）。
          比例：标 24px（墨迹约 19px）配 20px 字标，视觉等高；字标用亮段渐变
          （与 .dark 主题口径同款），纯白大字在黑底上会显得压闷。 */}
      <div className="flex w-full items-center gap-2 border-b border-white/[0.08] bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] px-3.5 py-3 [app-region:drag]">
        {/* 白标：品牌图为蓝色墨迹，brightness-0 invert 转成纯白（黑底上唯一可读形态）。 */}
        <WindowsTopLeftLogo
          className="static m-0 h-auto p-0"
          imageClassName="h-6 w-auto brightness-0 invert"
        />
        <span
          className="font-wordmark bg-clip-text text-[20px] leading-none tracking-tight text-transparent"
          style={{
            backgroundImage:
              "linear-gradient(90deg,#7f96ea 0%,#9db3f7 45%,#bccfff 100%)",
          }}
        >
          KenFutWork
        </span>
      </div>
      <WorkbenchModeNavigation {...snapshot} onModeChange={navigation.open} />
    </div>
  );
}
