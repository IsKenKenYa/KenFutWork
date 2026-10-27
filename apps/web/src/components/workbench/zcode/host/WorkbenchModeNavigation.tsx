import type { HostWorkbenchMode, HostWorkbenchNavigation } from "@zcode/shared";
import appLogoUrl from "@zui/assets/kenfutwork-mark.png";

import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import {
  Briefcase,
  Code2,
  Palette,
  PanelLeftOpen,
  Workflow,
} from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";
import { ProjectDirectoryRecovery } from "./ProjectDirectoryRecovery.js";

// 与 AboutSection 同一边界：Code 宿主的 Vite PNG 导入在运行时为 URL 字符串。
const logoSrc = appLogoUrl as unknown as string;

/** 展示顺序（用户口径）：Code → Design → Work → Flow，与可用性无关，缺档自动跳过。 */
const MODE_ORDER: readonly HostWorkbenchMode[] = [
  "code",
  "design",
  "work",
  "flow",
];
const MODE_LABELS: Record<HostWorkbenchMode, string> = {
  code: "Code",
  design: "Design",
  work: "Work",
  flow: "Flow",
};
// 收起态只有 48px 宽，标签放不下，仍用图标；展开态按用户口径只留文字。
const MODE_ICONS: Record<HostWorkbenchMode, ReactNode> = {
  code: <Code2 className="h-4 w-4 shrink-0" />,
  design: <Palette className="h-4 w-4 shrink-0" />,
  work: <Briefcase className="h-4 w-4 shrink-0" />,
  flow: <Workflow className="h-4 w-4 shrink-0" />,
};

/** 从CanvasSidebar原横排及收起按钮提取，Code／Design／Work／Flow共用展示。 */
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
  const modeItems = MODE_ORDER.filter((id) => availableModes.includes(id)).map(
    (id) => ({ id, label: MODE_LABELS[id], icon: MODE_ICONS[id] }),
  );
  if (collapsed)
    return (
      // 收起态与展开态是同一个控件：保留 radiogroup/radio 语义，
      // 否则侧栏一收，模式切换在读屏与自动化里就"消失"了。
      <div
        role="radiogroup"
        aria-label="模式切换"
        className="flex flex-col items-center gap-1"
      >
        {modeItems.map((item) => (
          // biome-ignore lint/a11y/useSemanticElements: 与展开态同款 radio 按钮，保持图标和布局
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={mode === item.id}
            title={item.label}
            aria-label={item.label}
            data-active={mode === item.id}
            onClick={() => onModeChange(item.id)}
            className="rounded-md p-2 hover:bg-surface-hover data-[active=true]:bg-selected data-[active=true]:text-foreground data-[active=false]:text-foreground-subtle"
          >
            {item.icon}
          </button>
        ))}
      </div>
    );
  return (
    <div className="px-2 pt-3 pb-1">
      {/* 用户口径：模式行上下加分界线（tab 轨道式 hairline），选中项灰底填充
          顶满两线——一眼可辨当前模式，又不回到胶囊容器的突兀。 */}
      <div
        role="radiogroup"
        aria-label="模式切换"
        className="flex items-stretch border-y border-foreground/20"
      >
        {modeItems.map((item) => (
          // biome-ignore lint/a11y/useSemanticElements: 提取现有分段radio按钮，保持文字分档的布局
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={mode === item.id}
            data-active={mode === item.id}
            onClick={() => onModeChange(item.id)}
            className="flex min-h-[34px] min-w-0 flex-1 items-center justify-center py-1.5 text-[13px] whitespace-nowrap text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground data-[active=true]:bg-selected data-[active=true]:text-foreground"
          >
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
  return (
    <>
      {navigation ? (
        <ConnectedWorkbenchModeNavigation
          navigation={navigation}
          actions={actions}
        />
      ) : null}
    </>
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
        {/* 黑标：品牌图为蓝色墨迹，brightness(0) 只留黑白；盒高 20px=字标行高，
            墨迹(盒的 71%)≈字标大写高——垂直居中即光学对齐（实测墨迹在画布中
            上下均分 148/147，无需位移补偿）。 */}
        {/* biome-ignore lint/performance/noImgElement: output: "export" 未开 images.unoptimized，next/image 会构建失败 */}
        <img
          src={logoSrc}
          alt="KenFutWork"
          className="h-5 w-auto brightness-0"
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
      {snapshot.mode === "code" ? <ProjectDirectoryRecovery /> : null}
    </div>
  );
}

const NOOP_SUBSCRIBE = () => () => {};
const FALLBACK_SNAPSHOT = {
  mode: "code" as const,
  availableModes: [] as readonly never[],
};

/**
 * 收起态图标栏（用户口径：收起不要收缩到什么都没有，像之前一样留一条 rail）：
 * 黑标 + 展开按钮 + 模式图标 + `actions` 槽（新建任务·搜索·插件市场·技能·MCP·插件面板）。
 * rail 曾经只有前三个图标，侧栏一收这些入口就整个消失（2026-10-19 用户口径），
 * 所以入口由调用方按展开态同一份定义喂进来。
 * 挂在壳侧栏 48px 宽的收起轨道里；桌面 chrome 形态不启用（那边有顶部浮层按钮）。
 */
export function HostSidebarRail({
  onExpand,
  actions,
}: {
  onExpand: () => void;
  actions?: React.ReactNode;
}) {
  const navigation = useOptionalPlatform()?.workbenchNavigation;
  const snapshot = useSyncExternalStore(
    navigation?.subscribe ?? NOOP_SUBSCRIBE,
    navigation?.getSnapshot ?? (() => FALLBACK_SNAPSHOT),
  );
  return (
    <div className="flex h-full min-h-0 w-full flex-col items-center gap-1 py-2">
      {/* biome-ignore lint/performance/noImgElement: output: "export" 未开 images.unoptimized，next/image 会构建失败 */}
      <img
        src={logoSrc}
        alt="KenFutWork"
        className="my-1 h-5 w-auto shrink-0 brightness-0"
        draggable={false}
      />
      <button
        type="button"
        aria-label="展开侧栏"
        title="展开侧栏"
        onClick={onExpand}
        className="shrink-0 rounded-md p-2 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
      >
        <PanelLeftOpen className="h-4 w-4" />
      </button>
      <div className="my-1 w-5 shrink-0 border-t" />
      {navigation ? (
        <div className="shrink-0">
          <WorkbenchModeNavigation
            {...snapshot}
            onModeChange={navigation.open}
            collapsed
          />
        </div>
      ) : null}
      {actions ? (
        <>
          {/* 与上面那条分界线同款（w-5 居中短线）；此前这条铺满 48px 轨道宽，
              两条线一长一短，视觉上像两个不同层级的分隔。 */}
          <div className="my-1 w-5 shrink-0 border-t" />
          <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto pb-1">
            {actions}
          </div>
        </>
      ) : null}
    </div>
  );
}
