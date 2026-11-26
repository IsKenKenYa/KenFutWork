/* eslint-disable max-lines -- 模型菜单同时维护触发器、模型项、provider family 连接方式子菜单和焦点恢复，拆开会增加受控 Dropdown 状态同步成本。 */

import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  testId,
} from "@zcode/shared";
import { ControlHintTooltip } from "@zui/ControlHintTooltip.js";
import { RollingToolbarLabel } from "@zui/chat-input-toolbar/RollingToolbarLabel.js";
import { cn } from "@zui/components/lib/utils.js";
import { ModelInputCapabilityBadge } from "@zui/components/ModelInputCapabilityBadge.js";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@zui/components/ui/select.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@zui/components/ui/tooltip.js";
import {
  isCoarseTouchDevice,
  shouldRestoreChatInputFocusAfterPickerClose,
} from "@zui/lib/pickerFocus.js";
import {
  AlertCircle,
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  PackageIcon,
} from "lucide-react";
import {
  Fragment,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface ModelSelectGroupItem {
  key: string;
  value: string;
  name: string;
  badgeLabel?: string;
  supportsVisionInput?: boolean;
}

export interface ModelSelectConnectionOption {
  key: string;
  label: string;
  badgeLabel?: string;
  value: string;
  providerId: string;
  familyId: string;
  mode: "oauth" | "apiKey";
  disabled?: boolean;
}

export interface ModelSelectGroup {
  key: string;
  label: string;
  labelBadge?: string;
  directItems?: boolean;
  selectedOptionKey?: string;
  connectionOptions?: ModelSelectConnectionOption[];
  items: ModelSelectGroupItem[];
}

export interface ModelSelectFooterAction {
  key: string;
  label: string;
  selected?: boolean;
  onSelect?: () => void;
}

const EMPTY_MODEL_SELECT_FOOTER_ACTIONS: readonly ModelSelectFooterAction[] =
  [];
export const MODEL_CONFIG_SELECT_BADGE_CLASS_NAME =
  "shrink-0 rounded-full bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle";

function shouldShowModelProviderLevel(
  modelGroups: readonly ModelSelectGroup[],
): boolean {
  return modelGroups.length > 0;
}

function isFamilyConnectionGroup(
  group: Pick<ModelSelectGroup, "connectionOptions" | "key" | "labelBadge">,
): boolean {
  return (
    group.key.startsWith("family:") ||
    Boolean(group.labelBadge?.trim()) ||
    (group.connectionOptions?.length ?? 0) > 0
  );
}

function shouldRenderModelGroupSeparator(
  previousGroup:
    | Pick<ModelSelectGroup, "connectionOptions" | "key" | "labelBadge">
    | undefined,
  currentGroup: Pick<
    ModelSelectGroup,
    "connectionOptions" | "key" | "labelBadge"
  >,
): boolean {
  if (!previousGroup) {
    return false;
  }
  return (
    isFamilyConnectionGroup(previousGroup) ||
    isFamilyConnectionGroup(currentGroup)
  );
}

function isModelSelectGroupSelected(
  group: Pick<ModelSelectGroup, "items">,
  normalizedValue: string,
): boolean {
  return group.items.some((item) => item.value === normalizedValue);
}

/** 思考档位的中文标签（与工具条其它地方的用词一致；未知值原样显示）。 */
const EFFORT_LEVEL_LABELS: Record<string, string> = {
  off: "关闭",
  none: "关闭",
  disable: "关闭",
  disabled: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  "extra-high": "极高",
  xhigh: "极高",
  max: "最高",
  ultra: "极致",
};

function effortLevelLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  return EFFORT_LEVEL_LABELS[normalized] ?? value;
}

/** 手柄直径（px）。与轨道同高，圆形正好嵌在轨道两端，不会上下错位。 */
const EFFORT_KNOB = 32;

/**
 * 触发器里档位读数的宽度（单位 em，`1em` = 一个中文字宽）。
 *
 * 用具体 em 值而不是让文字自然撑开：自然宽度是 `fit-content`，`transition: width`
 * 对它不生效，档位换长换短会瞬时跳（用户口径 2026-11-23 反复要求「加过渡动画」）。
 * 这里单字档给 1em（正好一个字的墨迹，不留空白），每多一个字加 1em。
 */
function effortReadoutWidthEm(label: string): number {
  return Math.max(1, label.length);
}

/**
 * 菜单里的分割线（模型菜单的两条、思考强度上方的那条）。
 *
 * 为什么是「2px 高 + 一半透明度」而不是 1px 实线：1px 线落在哪个物理像素取决于它在
 * 页面里的累计位置，分数倍缩放（Windows 125% / 150%，DPR 1.25 / 1.5）下两条位置不同的
 * 1px 线会被拆到不同的物理像素行——实测一条渲染成 48+65、另一条 54+59，用户看到的就是
 * 「两条不一样粗」。2px 高度必然覆盖整物理像素，边缘那半行只有一半透明度，两条线的
 * 观感就一致了；总墨量与 1px 实线相同，仍是细线。
 */
const MENU_DIVIDER_CLASS = "my-1 h-0.5 bg-border/50";

/** 「关闭」一类的档位不参与配色渐变（设计稿里的 None 档：灰、无特效）。 */
function isEffortPlainLevel(value: string): boolean {
  return ["off", "none", "disable", "disabled"].includes(
    value.trim().toLowerCase(),
  );
}

/** 设计稿的档位配色：色相 160→228、饱和 82→100、亮度 45→64，绿→蓝。 */
function effortLevelColor(index: number, count: number): string {
  if (count <= 1) return hslToHex(160, 82, 45);
  const t = index / (count - 1);
  return hslToHex(160 + 68 * t, 82 + 18 * t, 45 + 19 * t);
}

function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(
      255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))),
    );
  };
  return `#${f(0).toString(16).padStart(2, "0")}${f(8)
    .toString(16)
    .padStart(2, "0")}${f(4).toString(16).padStart(2, "0")}`;
}

/** 星星特效的落点（设计稿原样：大小、位置、错峰延迟）。 */
const EFFORT_STARS: ReadonlyArray<{
  left: string;
  top: string;
  size: number;
  delay: number;
}> = [
  { left: "8%", top: "26%", size: 13, delay: 0 },
  { left: "19%", top: "68%", size: 9, delay: 0.12 },
  { left: "31%", top: "24%", size: 10, delay: 0.05 },
  { left: "44%", top: "72%", size: 8, delay: 0.18 },
  { left: "56%", top: "30%", size: 14, delay: 0.08 },
  { left: "68%", top: "66%", size: 9, delay: 0.22 },
  { left: "80%", top: "26%", size: 11, delay: 0.14 },
  { left: "92%", top: "62%", size: 9, delay: 0.26 },
];

/** 滑块特效用的关键帧（组件级注入一次；WAAPI 不覆盖 infinite alternate 组合）。 */
const EFFORT_KEYFRAMES = `
/* 呼吸发光：只动 opacity（合成层属性），不再逐帧跑 brightness/saturate 滤镜。 */
@keyframes effort-glow-breathe {
  0%, 100% { opacity: .03; }
  50%      { opacity: .14; }
}
.effort-glow-breathe { animation: effort-glow-breathe 2.6s ease-in-out infinite; }
/* 档位读数：**机械电表滚动**（用户口径 2026-11-25「跟机械电表度数一样的那种」）。
   做法：把整列档位纵向排列成一条长带，容器只开一行的窗口（overflow hidden），
   换档时整条带子平移，当前档滚到窗口里——就是电表数字轮的动作。

   为什么比翻页好：翻页是「半页翻过去」，两字会短暂重叠造成重影；滚动是刚体平移，
   任何时刻窗口里只有一个档位，没有叠影也没有空白。
   曲线用 ease-out 收尾（电表停下有惯性感），时长与手感都在下面一处调。 */
.effort-readout-reel {
  transition: transform .42s cubic-bezier(.22, .61, .36, 1);
  will-change: transform;
}
@keyframes effort-star-in {
  0%   { transform: translate(-50%,-50%) scale(0) rotate(-90deg); opacity: 0; }
  70%  { transform: translate(-50%,-50%) scale(1.35) rotate(8deg); opacity: 1; }
  100% { transform: translate(-50%,-50%) scale(1) rotate(0deg); opacity: 1; }
}
@keyframes effort-star-twinkle {
  from { opacity: .4; transform: translate(-50%,-50%) scale(.7) rotate(-25deg); }
  to   { opacity: 1;  transform: translate(-50%,-50%) scale(1.2) rotate(25deg);  }
}
.effort-star { opacity: 0; will-change: transform, opacity; }
.effort-track-shine .effort-star {
  animation:
    effort-star-in .5s cubic-bezier(.34,1.56,.64,1) forwards,
    effort-star-twinkle 1.4s ease-in-out infinite alternate;
  animation-delay: var(--d, 0s), calc(var(--d, 0s) + .5s);
}
.effort-track-shine .effort-star:nth-child(even) {
  animation-direction: normal, alternate-reverse;
}
`;

/**
 * 思考强度滑块：按用户给定的设计稿实现（档位吸附 + 呼吸发光 + 双闪光扫过 +
 * 最高档星星），档位越高特效越强。
 *
 * 为什么是滑块而不是下拉：档位是**有序**的少量档（低→高），滑块让「现在偏哪一侧、
 * 还能往哪边推」一眼可见；下拉只给出当前值，要读完全部选项才知道位置。
 *
 * 几何口径：手柄圆心始终内缩手柄半径，落点圆点与手柄同位——推到两端时
 * 手柄与圆点都不会伸出轨道（用户反馈「圆点溢出」）。
 */
function EffortSlider({
  option,
  onValueChange,
  disabled,
}: {
  option: {
    currentValue?: string | boolean;
    options?: readonly { value: string; name?: string }[];
  };
  onValueChange: (value: string) => void;
  disabled: boolean;
}) {
  const levels = option.options ?? [];
  const currentValue =
    typeof option.currentValue === "string" ? option.currentValue : "";
  const upstreamIndex = levels.findIndex(
    (level) => level.value === currentValue,
  );
  // 拖动中的预览档位：只在本地画，松手才提交。拖动时逐档提交会触发保存与
  // 整块重渲染，实测表现为「拖动很卡、界面一直闪」。
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  /**
   * 指针是否已经拖离按下时那一档
   * （用户口径 2026-11-25「加一点点过渡动画，就像下面的选择器文本一样」）。
   *
   * 按下不算拖动：手柄与填充带着过渡滑向按下的档位，与触发器文字的宽度过渡同款
   * （300ms ease-out）。指针跨到别的档位后改为跟手、不做过渡——拖动时手柄要追着
   * 指针，带过渡会发飘。
   *
   * 判据取「档位变了」：指针在同一档的范围内移动时档位不变，手柄本来就不需要动；
   * 跨过分界的那一刻才需要立刻跟手。
   */
  const [tracking, setTracking] = useState(false);
  /** 按下时指针所在的那一档，用来判断之后是否拖离。 */
  const pressIndexRef = useRef<number | null>(null);
  /**
   * 松手后上游尚未回写的档位：`value` 是松手选的档，`from` 是松手那一刻的上游值。
   *
   * 为什么需要：`option.currentValue` 是异步回写的。选档 → 草稿变化 →
   * `useModelSelectionServiceView` 重新读取 → 视图回来，`currentValue` 才变，
   * 实测 41–59ms。松手时若直接清掉预览，这几帧会按旧档位画：填充先缩再涨
   * （实测最长缩掉三分之一）、手柄往回走再被拉回、读数往回滚
   * （用户口径 2026-11-25「进度条闪烁」「按钮有概率回弹」）。
   * 所以松手后继续画选中的档，上游值离开 `from` 时再交还给上游。
   */
  const [pendingChange, setPendingChange] = useState<{
    value: string;
    from: string;
  } | null>(null);
  const heldIndex =
    pendingChange && currentValue === pendingChange.from
      ? levels.findIndex((level) => level.value === pendingChange.value)
      : -1;
  const committedIndex =
    heldIndex >= 0 ? heldIndex : Math.max(0, upstreamIndex);
  /** 界面正显示的档位值：回写未到时是本地占位，否则是上游值。 */
  const shownValue =
    heldIndex >= 0 && pendingChange ? pendingChange.value : currentValue;
  // 上游回写完成，或被别处改成了第三个值：撤掉本地占位。
  useEffect(() => {
    if (pendingChange && currentValue !== pendingChange.from) {
      setPendingChange(null);
    }
  }, [currentValue, pendingChange]);
  const currentIndex = dragIndex ?? committedIndex;
  const dragging = dragIndex !== null;
  const current = levels[currentIndex];
  const last = levels.length - 1;
  const ratio = last <= 0 ? 1 : currentIndex / last;
  /** 滚动带要停在第几档：拖动中跟预览档走（跟手），否则用已落定的档位。 */
  const reelIndex = currentIndex;
  // 档位标签**必须**查 `value`：上游把 `name` 原样填成 `"max"`/`"xhigh"`，
  // 用 name 会继续把原始值摆到界面上（用户口径：不露英文原始值）。
  const label = current ? effortLevelLabel(current.value) : "—";
  const plain = current ? isEffortPlainLevel(current.value) : true;

  // 各档位颜色：关闭档灰、其余按设计稿色相坡铺开；渐变stop落在手柄行程上。
  const colored = levels.filter((level) => !isEffortPlainLevel(level.value));
  const colorByValue = new Map<string, string>();
  colored.forEach((level, index) => {
    colorByValue.set(level.value, effortLevelColor(index, colored.length));
  });
  const stops = levels.map((level, index) => ({
    value: level.value,
    stop: last <= 0 ? 0 : index / last,
    color: colorByValue.get(level.value) ?? null,
  }));
  const coloredStops = stops.filter((stop) => stop.color !== null);
  const currentColor = colorByValue.get(current?.value ?? "") ?? null;
  const isTop = currentIndex === last && last > 0 && !plain;

  const trackRef = useRef<HTMLDivElement | null>(null);
  const gradRef = useRef<HTMLDivElement | null>(null);
  const shimmerFirstRef = useRef<HTMLDivElement | null>(null);
  const shimmerSecondRef = useRef<HTMLDivElement | null>(null);
  const knobRef = useRef<HTMLSpanElement | null>(null);

  // 闪光扫过（WAAPI）：速率随档位升高而加快，与设计稿同一手法。
  // 动画句柄存 ref：档位变化时直接改 playbackRate，不再每帧 getAnimations() 查询。
  const shimmerRef = useRef<{ first?: Animation; second?: Animation }>({});
  useEffect(() => {
    const flow = [
      { transform: "translateX(-130%) skewX(-18deg)" },
      { transform: "translateX(340%) skewX(-18deg)" },
    ];
    const first = shimmerFirstRef.current?.animate(flow, {
      duration: 2400,
      iterations: Infinity,
      easing: "linear",
    });
    const second = shimmerSecondRef.current?.animate(flow, {
      duration: 2400,
      delay: -1200,
      iterations: Infinity,
      easing: "linear",
    });
    shimmerRef.current = { first, second };
    return () => {
      first?.cancel();
      second?.cancel();
      shimmerRef.current = {};
    };
  }, []);

  // 档位变化：特效强度与速率跟着档位走。
  useEffect(() => {
    const rate = 0.5 + 1.7 * ratio;
    if (shimmerRef.current.first) {
      shimmerRef.current.first.playbackRate = rate;
    }
    if (shimmerRef.current.second) {
      shimmerRef.current.second.playbackRate = rate;
    }
  }, [ratio]);

  /** 指针横坐标吸附到哪一档；量不到轨道宽度时返回 null。 */
  const nearestIndex = useCallback(
    (clientX: number): number | null => {
      const element = trackRef.current;
      if (!element || levels.length === 0) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const travel = rect.width - EFFORT_KNOB;
      const nextRatio = Math.min(
        1,
        Math.max(0, (clientX - rect.left - EFFORT_KNOB / 2) / travel),
      );
      return Math.round(nextRatio * last);
    },
    [last, levels.length],
  );

  /**
   * 松手才提交：整段拖动只写一次，避免逐档保存与重渲染。
   *
   * 提交条件取「界面正显示的档」。回写未到时界面显示的是上一次松手的档：
   * 再松手到同一档不需要重发；松手回到上游原档则必须重发，
   * 否则上一次还在路上的回写会把它盖掉。
   */
  const commitDrag = useCallback(() => {
    const index = dragIndex;
    setDragIndex(null);
    setTracking(false);
    const next = index === null ? undefined : levels[index];
    if (!next || next.value === shownValue) return;
    setPendingChange({ value: next.value, from: currentValue });
    onValueChange(next.value);
  }, [currentValue, dragIndex, levels, onValueChange, shownValue]);

  const move = useCallback(
    (delta: number) => {
      const nextIndex = Math.min(last, Math.max(0, currentIndex + delta));
      const next = levels[nextIndex];
      if (next && next.value !== currentValue) onValueChange(next.value);
    },
    [currentIndex, last, levels, onValueChange, currentValue],
  );

  return (
    <div className="mt-1 pb-1">
      {/* 分割线与上下文容量面板同款：实线 border，左右内缩，不贴菜单边缘。 */}
      <style>{EFFORT_KEYFRAMES}</style>
      <div
        className={MENU_DIVIDER_CLASS}
        aria-hidden="true"
        style={{ marginLeft: 12, marginRight: 12 }}
      />
      <div className="px-2 pb-3 pt-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-ui-base text-foreground-subtle">思考强度</span>
          {/*
            档位读数：与标签同字重、只靠颜色区分（用户口径「最高不要加粗」）。

            换档过渡＝**机械电表滚动**（用户口径 2026-11-25「跟机械电表度数一样的那种」）。
            演进：① key 重挂载淡入（瞬断）→ ② 交叉淡入淡出（重影，用户说更丑）
            → ③ 日历翻页（用户觉得不够优雅）→ ④ 现在：整列档位排成一条纵带，
            窗口只开一行，换档时整条带子平移、当前档滚进窗口。

            为什么滚动更像电表：刚体平移任何时刻窗口里只有一档，没有重影、没有空白。
            `reelIndex` 用拖动中的预览档（拖到哪滚到哪，跟手），松手后再提交。
          */}
          <span className="relative block h-[1.4em] overflow-hidden text-ui-base tabular-nums">
            <span
              className="effort-readout-reel block"
              style={{
                transform: `translateY(${-reelIndex * 1.4}em)`,
                ...(plain || !currentColor ? {} : { color: currentColor }),
              }}
            >
              {levels.map((level) => {
                const text = effortLevelLabel(level.value);
                return (
                  <span
                    key={level.value}
                    // 每格固定 1.4em 行高：带子的位移量、窗口高度、格子高度
                    // 三者必须同源，否则滚到位会差几像素（读起来像没对齐）。
                    className="block h-[1.4em] leading-[1.4em]"
                  >
                    {text}
                  </span>
                );
              })}
            </span>
          </span>
        </div>
        {/* 轨道固定高度、手柄不再超出轨道：手柄改成与轨道同高（h-8），
            避免上下各露 2px 造成的错位观感。 */}
        <div
          ref={trackRef}
          role="slider"
          aria-label="思考强度"
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={currentIndex}
          aria-valuetext={label}
          aria-disabled={disabled}
          tabIndex={disabled ? -1 : 0}
          className={cn(
            "relative mt-3 h-8 w-full cursor-pointer rounded-full bg-hover outline-none focus-visible:ring-2 focus-visible:ring-ring",
            disabled && "cursor-not-allowed opacity-50",
          )}
          onPointerDown={(event) => {
            if (disabled) return;
            // 滑块独占这次按下。模型菜单是弹层，DOM 在页面根部，React 事件仍沿
            // 组件树冒泡到输入框表层，那里的「按住说话」会起 200ms 计时，到点抢走
            // 指针捕获并开始录音——按住超过 200ms 再松手，松手事件到不了滑块，
            // 这次选择不会提交。
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            const next = nearestIndex(event.clientX);
            if (next === null) return;
            // 按下只是「指着这一档」，手柄带过渡滑过来；拖离之后才跟手。
            pressIndexRef.current = next;
            setTracking(false);
            setDragIndex(next);
          }}
          onPointerMove={(event) => {
            if (disabled) return;
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const next = nearestIndex(event.clientX);
            if (next === null) return;
            if (next !== pressIndexRef.current) setTracking(true);
            setDragIndex(next);
          }}
          onPointerUp={() => {
            if (disabled) return;
            commitDrag();
          }}
          onPointerCancel={() => {
            if (disabled) return;
            commitDrag();
          }}
          onKeyDown={(event) => {
            if (disabled) return;
            if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
              event.preventDefault();
              move(-1);
            } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
              event.preventDefault();
              move(1);
            } else if (event.key === "Home") {
              event.preventDefault();
              move(-levels.length);
            } else if (event.key === "End") {
              event.preventDefault();
              move(levels.length);
            }
          }}
        >
          {/*
            渐变填充：按档位配色铺 stop，用 `clip-path: inset()` 裁到当前档位。

            这里必须是 `clip-path` 而不是 `mask-image`：遮罩里的渐变**不能插值**，
            `transition: mask-image` 等于没写，档位变化会瞬跳（用户连问六遍
            「为什么你不加过渡动画」就是这个原因）。`inset()` 的四个 inset 值与
            父级圆角无关，可以逐帧插值，所以填充宽度是真的在动。

            裁剪必须带 `round`：不带时填充右端是直角方块（用户截图反馈「有bug」）。
            半径用轨道半高 `16px` 而不是 `999px`：半径只需等于半高就能得到完全圆头，
            `999px` 每次变化都要按巨大半径重算轮廓，是之前「有点卡」的一半原因。
            呼吸发光不用 `filter`（每帧跑像素级滤镜），改透明度叠层。
          */}
          <div
            ref={gradRef}
            aria-hidden="true"
            className="absolute inset-0 overflow-hidden rounded-full"
          >
            <div
              aria-hidden="true"
              className="absolute inset-0 rounded-full"
              style={{
                background:
                  coloredStops.length >= 2
                    ? `linear-gradient(90deg, ${coloredStops
                        .map(
                          (stop) =>
                            `${stop.color} calc(${EFFORT_KNOB / 2}px + ${stop.stop.toFixed(4)} * (100% - ${EFFORT_KNOB}px))`,
                        )
                        .join(", ")})`
                    : (coloredStops[0]?.color ?? "transparent"),
                clipPath: `inset(0 calc(${((1 - ratio) * 100).toFixed(2)}% - ${((1 - ratio) * EFFORT_KNOB).toFixed(2)}px) 0 0 round ${EFFORT_KNOB / 2}px)`,
                // 拖离按下那一档之后不做过渡：每一帧都重启动画会让拖动发飘。
                transition: tracking
                  ? "none"
                  : "clip-path .32s cubic-bezier(.32, .72, .24, 1)",
                willChange: dragging ? "clip-path" : undefined,
              }}
            >
              {/* 顶面高光（设计稿 rs-grad::after）。 */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-0 right-0 top-0 h-[52%] rounded-[999px_999px_40%_40%/999px_999px_70%_70%] bg-gradient-to-b from-white/30 to-transparent"
              />
              {/* 双闪光扫过：档位越高越亮、越快。 */}
              <div
                ref={shimmerFirstRef}
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-[-10%] left-0 w-[42%] skew-x-[-18deg] rounded-full bg-gradient-to-r from-transparent via-white/40 to-transparent will-change-transform"
                style={{
                  opacity: plain ? 0 : Math.min(1, 0.06 + 0.165 * ratio),
                  transform: "translateX(-130%) skewX(-18deg)",
                }}
              />
              <div
                ref={shimmerSecondRef}
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-[-10%] left-0 w-[42%] skew-x-[-18deg] rounded-full bg-gradient-to-r from-transparent via-white/40 to-transparent will-change-transform"
                style={{
                  opacity: plain ? 0 : Math.max(0, (ratio - 0.4) * 0.25),
                  transform: "translateX(-130%) skewX(-18deg)",
                }}
              />
            </div>
            {/* 呼吸发光：半透明白色叠层做透明度呼吸，替掉逐帧 brightness 滤镜。 */}
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-0 rounded-full bg-white/10",
                !plain && !isTop && "effort-glow-breathe",
              )}
              style={{ opacity: plain || isTop ? 0 : undefined }}
            />
          </div>
          {/* 最高档星星（设计稿 rs-stars）：只在顶档出现。
              overflow-hidden 把星星关在轨道内——它撑开容器会让整块面板跳动。 */}
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 overflow-hidden rounded-full",
              isTop && "effort-track-shine",
            )}
          >
            {EFFORT_STARS.map((star, index) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: 星星是固定装饰表，位置稳定。
                key={index}
                className="effort-star absolute text-white drop-shadow-[0_0_3px_rgba(255,255,255,0.9)]"
                style={{
                  left: star.left,
                  top: star.top,
                  fontSize: star.size,
                  ["--d" as string]: `${star.delay}s`,
                }}
              >
                ✦
              </span>
            ))}
          </div>
          {/* 档位落点圆点：与手柄同一条行程线，内缩手柄半径，不再溢出。 */}
          {stops.map((stop) => (
            <span
              key={stop.value}
              aria-hidden="true"
              className="absolute top-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_3px_rgba(31,45,61,0.28)]"
              style={{
                left: `calc(${EFFORT_KNOB / 2}px + ${stop.stop.toFixed(4)} * (100% - ${EFFORT_KNOB}px))`,
              }}
            />
          ))}
          <span
            ref={knobRef}
            aria-hidden="true"
            className={cn(
              // 手柄与轨道同高（32px）：不再上下各露一截，滑块与轨道对齐。
              //
              // 居中方式：`top-1/2` + 负 margin。手柄的位置过渡只动 `left`，
              // 居中不占用 `transform` / `translate`，不会被别的变换叠加出偏移。
              "pointer-events-none absolute top-1/2 z-[2] size-8 -mt-4 -ml-4 rounded-full bg-white shadow-[0_2px_10px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.03)]",
              // 拖离按下那一档后手柄跟手、不做位置过渡；其余时候带 300ms ease-out，
              // 与触发器文字的宽度过渡同款。
              !tracking && "transition-[left] duration-300 ease-out",
            )}
            style={{
              left: `calc(${EFFORT_KNOB / 2}px + ${ratio.toFixed(4)} * (100% - ${EFFORT_KNOB}px))`,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function getModelTriggerLabelClassName({
  labelVisibilityClassName,
  triggerLabelClassName,
}: {
  labelVisibilityClassName: string | undefined;
  triggerLabelClassName?: string;
}): string {
  if (triggerLabelClassName?.trim()) {
    return triggerLabelClassName;
  }

  return cn("min-w-0 text-left", labelVisibilityClassName);
}

interface ModelConfigSelectProps {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  triggerLabel: string;
  triggerLabelPrefix?: string;
  triggerLabelValue?: string;
  triggerLabelPrefixClassName?: string;
  showManageModelsAction: boolean;
  lockReasonMessage: string;
  isItemLocked: (candidateValue: string) => boolean;
  onValueChange: (value: string) => void;
  onConnectionValueChange?: (option: ModelSelectConnectionOption) => void;
  disabled?: boolean;
  tooltipTitle?: string;
  guideTooltipTitle?: ReactNode;
  guideTooltipOpen?: boolean;
  onGuideTooltipDismiss?: () => void;
  shortcutLabel?: string;
  triggerRef?: RefObject<HTMLSpanElement | null>;
  /** 传入时由调用方统一协调菜单；省略则保持组件原有的内部开关状态。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  openRequestKey?: number;
  pendingLabel?: string | null;
  pending?: boolean;
  labelVisibilityClassName?: string;
  indicatorClassName?: string;
  triggerClassName?: string;
  triggerIconClassName?: string;
  triggerLabelClassName?: string;
  triggerTestId?: string;
  formatTriggerLabel?: (label: string) => string;
  /** false 时把第一个 group 作为无 provider 层的扁平模型列表展示。 */
  showProviderLevel?: boolean;
  /** 覆盖 provider 二级模型菜单样式；缺省按内容扩展并保留最小宽度。 */
  providerSubmenuClassName?: string;
  footerActions?: readonly ModelSelectFooterAction[];
  manageModelsLabel?: string;
  onManageModels?: () => void;
  focusSelectorOnClose?: string | null;
  contentSide?: "top" | "bottom" | "left" | "right";
  contentAlign?: "start" | "center" | "end";
  /**
   * 排在所有分组之上的单选项（与分组之间隔一条线）。工作流「配置」弹层用它把「会话模型」放在第一位；
   * 缺省即无。
   */
  leadingItems?: readonly ModelSelectGroupItem[];
  /** 触发器里标签之后的小徽标（如「会话模型」「不可用」）；缺省即无。 */
  triggerBadge?: ReactNode;
  /**
   * 思考强度：与模型同属一个菜单（选模型与调档是同一件事）。
   *
   * 传 undefined 表示当前模型没有可选档位——整段不渲染，不摆空滑块。
   * 放在常驻的模型菜单里，切换档位时只重渲染滑块本身；此前它是工具条上的
   * 独立控件，切换模型会让它整块卸载重建（用户看到的界面闪烁）。
   */
  effort?: {
    option: {
      currentValue?: string | boolean;
      options?: readonly { value: string; name?: string }[];
    } | null;
    onValueChange: (value: string) => void;
    disabled?: boolean;
  };
}

export const ModelConfigSelect = memo(function ModelConfigSelectComponent({
  modelGroups,
  normalizedValue,
  triggerLabel,
  triggerLabelPrefix,
  triggerLabelValue,
  triggerLabelPrefixClassName,
  showManageModelsAction,
  lockReasonMessage,
  isItemLocked,
  onValueChange,
  onConnectionValueChange,
  disabled,
  tooltipTitle,
  guideTooltipTitle,
  guideTooltipOpen = false,
  onGuideTooltipDismiss,
  shortcutLabel,
  triggerRef,
  open: controlledOpen,
  onOpenChange,
  openRequestKey = 0,
  pendingLabel,
  pending,
  labelVisibilityClassName = "hidden @xl/composer:inline-flex",
  indicatorClassName,
  triggerClassName,
  triggerIconClassName = "hidden",
  triggerLabelClassName: customTriggerLabelClassName,
  triggerTestId = TID_CHAT_MODEL_SELECT_TRIGGER,
  formatTriggerLabel,
  showProviderLevel,
  providerSubmenuClassName,
  footerActions = EMPTY_MODEL_SELECT_FOOTER_ACTIONS,
  manageModelsLabel,
  onManageModels,
  focusSelectorOnClose = '[data-testid="chat-input"]',
  contentSide = "top",
  contentAlign = "start",
  leadingItems,
  triggerBadge,
  effort,
}: ModelConfigSelectProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const lastOpenRequestKeyRef = useRef(openRequestKey);
  const hasSelectableModel = modelGroups.length > 0;
  // 闲时任务白名单只有一层模型值；只要存在 group 就强制展示 provider 层的话，
  // 下方已有的扁平模型分支永远不可达，也无法复用 New Task 模型选择器。
  const shouldShowProviderLevel =
    showProviderLevel ?? shouldShowModelProviderLevel(modelGroups);
  // 模型名和上游占位值可能大小写敏感，强制大写会把 `<synthetic>` 改成 `<SYNTHETIC>` 这类非原始值。
  const triggerDisplayLabel = triggerLabel;
  const renderedTriggerDisplayLabel =
    formatTriggerLabel?.(triggerDisplayLabel) ?? triggerDisplayLabel;
  const renderedPendingLabel =
    pendingLabel && formatTriggerLabel
      ? formatTriggerLabel(pendingLabel)
      : pendingLabel;
  const currentTriggerLabel =
    pending && renderedPendingLabel
      ? renderedPendingLabel
      : renderedTriggerDisplayLabel;
  // 触发器同时显示思考程度（用户口径）：模型名 · 档位，一眼读全这次怎么跑。
  const effortTriggerLabel =
    effort?.option && (effort.option.options?.length ?? 0) > 1
      ? (() => {
          const value = effort.option.currentValue;
          if (typeof value !== "string" || !value) return null;
          return effortLevelLabel(value);
        })()
      : null;
  const currentTriggerTitle =
    pending && pendingLabel ? pendingLabel : triggerDisplayLabel;
  const triggerLabelClassName = getModelTriggerLabelClassName({
    labelVisibilityClassName,
    triggerLabelClassName: customTriggerLabelClassName,
  });

  const handlePopoverOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange],
  );

  useEffect(() => {
    if (
      openRequestKey <= 0 ||
      openRequestKey === lastOpenRequestKeyRef.current
    ) {
      return;
    }
    lastOpenRequestKeyRef.current = openRequestKey;

    if (disabled) {
      return;
    }

    // 模型菜单是受控 DropdownMenu，快捷键不能依赖模拟 click 触发。
    // Tooltip/Dropdown 多层 asChild 合并 ref 时，click 可能找不到真实 trigger；这里直接打开菜单状态。
    handlePopoverOpenChange(true);
    triggerRef?.current?.focus();
  }, [disabled, handlePopoverOpenChange, openRequestKey, triggerRef]);

  const handleModelValueChange = useCallback(
    (nextValue: string) => {
      onValueChange(nextValue);
    },
    [onValueChange],
  );

  const triggerAriaLabel = useMemo(() => {
    return pending && pendingLabel
      ? pendingLabel
      : (tooltipTitle ?? currentTriggerTitle);
  }, [currentTriggerTitle, pending, pendingLabel, tooltipTitle]);

  const renderModelItem = useCallback(
    (item: ModelSelectGroupItem) => {
      const itemLocked = isItemLocked(item.value);
      const itemSelected = item.value === normalizedValue;
      // React 的 key 不能跟随 props spread 传入，否则开发环境会在 CDP console 报警。
      const itemKey = item.key;
      const commonProps = {
        "data-model-option-locked": itemLocked ? "true" : undefined,
        "data-model-option-selected": itemSelected ? "true" : undefined,
        "data-testid": testId(TID_CHAT_MODEL_SELECT_ITEM, item.value),
        "data-checked": itemSelected ? "true" : undefined,
      } as const;
      const content = (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <span className="min-w-0 truncate" title={item.name}>
              {item.name}
            </span>
            {item.badgeLabel ? (
              <span className={MODEL_CONFIG_SELECT_BADGE_CLASS_NAME}>
                {item.badgeLabel}
              </span>
            ) : null}
            {item.supportsVisionInput ? <ModelInputCapabilityBadge /> : null}
          </span>
          {itemLocked ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="inline-flex size-4 items-center justify-center rounded-full text-foreground-subtlest hover:text-foreground-subtle"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    <AlertCircle className="size-4" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" align="center" sideOffset={6}>
                  {lockReasonMessage}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          {itemLocked && itemSelected ? (
            <CheckIcon className="size-4 text-foreground-subtle" />
          ) : null}
        </>
      );

      if (itemLocked) {
        return (
          <DropdownMenuItem
            key={itemKey}
            {...commonProps}
            className="min-h-8 cursor-not-allowed gap-2 px-2 text-ui-base text-foreground-subtlest data-[highlighted]:text-foreground-subtlest"
            onSelect={(event) => event.preventDefault()}
          >
            {content}
          </DropdownMenuItem>
        );
      }

      return (
        <DropdownMenuRadioItem
          key={itemKey}
          {...commonProps}
          value={item.value}
          className="min-h-8 gap-2 pl-2 pr-8 text-ui-base"
          onSelect={() => {
            handleModelValueChange(item.value);
            handlePopoverOpenChange(false);
          }}
        >
          {content}
        </DropdownMenuRadioItem>
      );
    },
    [
      handleModelValueChange,
      handlePopoverOpenChange,
      isItemLocked,
      lockReasonMessage,
      normalizedValue,
    ],
  );

  const renderModelItems = useCallback(
    (items: readonly ModelSelectGroupItem[]) => (
      <DropdownMenuRadioGroup value={normalizedValue}>
        {items.map((item) => renderModelItem(item))}
      </DropdownMenuRadioGroup>
    ),
    [normalizedValue, renderModelItem],
  );

  const renderGroupLabel = useCallback(
    (group: ModelSelectGroup, options: { mutedLabel?: boolean } = {}) => (
      <span className="min-w-0 flex-1 items-center gap-1.5 text-left inline-flex">
        <span
          className={cn(
            "min-w-0 whitespace-normal break-words text-ui-base",
            options.mutedLabel && "text-foreground-subtle",
          )}
          title={group.label}
        >
          {group.label}
        </span>
        {group.labelBadge ? (
          <span className={MODEL_CONFIG_SELECT_BADGE_CLASS_NAME}>
            {group.labelBadge}
          </span>
        ) : null}
      </span>
    ),
    [],
  );

  const renderProviderConnectionHeader = useCallback(
    (group: ModelSelectGroup) => {
      const options = group.connectionOptions ?? [];
      if (options.length > 0) {
        const selectedOptionKey = group.selectedOptionKey ?? options[0]?.key;
        const selectedConnection =
          options.find((option) => option.key === selectedOptionKey) ??
          options[0];
        return (
          <div className="flex min-h-8 items-center gap-2 px-2 py-1">
            <span
              className="min-w-0 flex-1 truncate text-left text-ui-sm font-medium text-foreground-subtlest"
              title={group.label}
            >
              {group.label}
            </span>
            <Select
              value={selectedOptionKey}
              onValueChange={(nextKey) => {
                const option = options.find(
                  (candidate) => candidate.key === nextKey,
                );
                if (!option) {
                  return;
                }
                // 切换连接方式后需要保留外层模型菜单，方便用户继续选择刷新后的模型。
                onConnectionValueChange?.(option);
              }}
            >
              <SelectTrigger
                size="xs"
                variant="outline"
                className="min-w-0 shrink-0 gap-0.5 rounded-full pr-1.5 text-ui-sm text-foreground-subtle [&_svg]:size-3"
                data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, group.key)}
                data-model-provider-key={group.key}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <span className="max-w-28 truncate">
                  {selectedConnection?.badgeLabel ??
                    selectedConnection?.label ??
                    group.label}
                </span>
              </SelectTrigger>
              <SelectContent
                align="end"
                position="popper"
                className="w-max min-w-40 max-w-72"
                onCloseAutoFocus={(event) => event.preventDefault()}
              >
                {options.map((option) => (
                  <SelectItem
                    key={option.key}
                    value={option.key}
                    data-model-connection-option={option.key}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      }

      return null;
    },
    [onConnectionValueChange],
  );

  const renderedFooterActions = useMemo<ModelSelectFooterAction[]>(() => {
    const actions = [...footerActions];
    if (showManageModelsAction && manageModelsLabel) {
      actions.push({
        key: "manage-models",
        label: manageModelsLabel,
        onSelect: onManageModels,
      });
    }
    return actions;
  }, [
    footerActions,
    manageModelsLabel,
    onManageModels,
    showManageModelsAction,
  ]);

  const modelTrigger = (
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="default"
        disabled={disabled}
        data-chat-toolbar-popover-trigger="true"
        data-testid={triggerTestId}
        data-model-current-value={normalizedValue}
        aria-label={triggerAriaLabel}
        onClick={guideTooltipOpen ? onGuideTooltipDismiss : undefined}
        className={cn(
          "w-fit justify-between gap-1 rounded-lg pl-2 pr-1.5 text-ui-base whitespace-nowrap",
          triggerClassName,
        )}
      >
        <PackageIcon
          className={cn(
            "pointer-events-none size-4 shrink-0 text-current",
            triggerIconClassName,
          )}
          aria-hidden="true"
        />
        <span className={triggerLabelClassName} title={currentTriggerTitle}>
          <RollingToolbarLabel
            label={currentTriggerLabel}
            prefix={pending ? undefined : triggerLabelPrefix}
            prefixClassName={triggerLabelPrefixClassName}
            value={pending ? undefined : triggerLabelValue}
          />
        </span>
        {effortTriggerLabel ? (
          <>
            <span className="text-foreground-subtle">·</span>
            {/*
              档位读数：与模型名同字重（用户口径「最高不要加粗」），宽度按字数取
              `em`（1 字 = 1em ≈ 墨迹宽度，所以单字档不会空出一截，用户口径
              2026-11-23「低的时候中间有一块空格」）。

              为什么宽度用 `em` 而不是让它自然撑开：自然宽度走 `fit-content`，
              `transition: width` 对 `fit-content` **不生效**，档位从「高」变「最高」
              时整块瞬时跳一下——用户连问六遍要过渡动画就是这个。

              现在宽度是具体值（1em / 1.4em），可以对它做过渡：触发器与
              菜单锚点一起连续变化。1.4em 给「最高」这类两字档留一点排布余量，
              单字档正好 1em，不产生额外留白。
            */}
            <span
              className="inline-block shrink-0 text-center tabular-nums transition-[width] duration-300 ease-out"
              style={{ width: `${effortReadoutWidthEm(effortTriggerLabel)}em` }}
            >
              {effortTriggerLabel}
            </span>
          </>
        ) : null}
        {triggerBadge}
        {pending ? (
          <LoaderIcon className="pointer-events-none size-3.5 animate-spin text-foreground" />
        ) : null}
        {!pending && (
          <ChevronDownIcon
            className={cn(
              "pointer-events-none size-3.5 text-foreground-subtle",
              indicatorClassName,
            )}
          />
        )}
      </Button>
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu open={open} onOpenChange={handlePopoverOpenChange}>
      {tooltipTitle ? (
        <ControlHintTooltip
          title={
            guideTooltipOpen && guideTooltipTitle
              ? guideTooltipTitle
              : tooltipTitle
          }
          shortcut={guideTooltipOpen ? undefined : shortcutLabel}
          triggerRef={triggerRef}
          open={guideTooltipOpen ? true : undefined}
          className={
            guideTooltipOpen ? "bg-background py-0.5 pr-0.5 pl-2" : undefined
          }
        >
          {modelTrigger}
        </ControlHintTooltip>
      ) : (
        modelTrigger
      )}
      {open ? (
        <DropdownMenuContent
          className={cn(
            shouldShowProviderLevel
              ? "w-max min-w-48 max-w-[calc(100vw-2rem)]"
              : "w-48 max-h-72 overflow-y-auto",
          )}
          align={contentAlign}
          side={contentSide}
          onCloseAutoFocus={(event) => {
            if (!focusSelectorOnClose) {
              // Automations 没有聊天输入框可恢复；保留 Radix 默认行为，
              // 让键盘焦点回到触发器，而不是 preventDefault 后掉到 body。
              return;
            }
            event.preventDefault();
            if (
              !shouldRestoreChatInputFocusAfterPickerClose({
                isCoarseTouchDevice: isCoarseTouchDevice(),
              })
            ) {
              return;
            }
            // 聊天输入框的 data-testid 挂在 contenteditable 自身上，不是父节点。
            // 这里与 mode 选择器保持同一个入口，避免关闭模型弹层后找不到输入框而丢失焦点。
            const input =
              document.querySelector<HTMLElement>(focusSelectorOnClose);
            input?.focus();
          }}
        >
          {leadingItems !== undefined && leadingItems.length > 0 ? (
            <>
              {renderModelItems(leadingItems)}
              {hasSelectableModel ? (
                <div
                  className={MENU_DIVIDER_CLASS}
                  aria-hidden="true"
                  style={{ marginLeft: 12, marginRight: 12 }}
                />
              ) : null}
            </>
          ) : null}
          {hasSelectableModel && shouldShowProviderLevel
            ? modelGroups.map((group, index) => {
                const groupSeparator = shouldRenderModelGroupSeparator(
                  modelGroups[index - 1],
                  group,
                ) ? (
                  <div
                    className={MENU_DIVIDER_CLASS}
                    aria-hidden="true"
                    style={{ marginLeft: 12, marginRight: 12 }}
                  />
                ) : null;
                if (group.directItems) {
                  return (
                    <Fragment key={group.key}>
                      {groupSeparator}
                      <div>
                        <DropdownMenuLabel
                          className="flex min-h-8 items-center px-2 py-1"
                          data-testid={testId(
                            TID_CHAT_MODEL_SELECT_GROUP,
                            group.key,
                          )}
                          data-model-provider-key={group.key}
                        >
                          {renderGroupLabel(group)}
                        </DropdownMenuLabel>
                        {renderProviderConnectionHeader(group)}
                        <DropdownMenuRadioGroup value={normalizedValue}>
                          {group.items.map((item) => renderModelItem(item))}
                        </DropdownMenuRadioGroup>
                      </div>
                    </Fragment>
                  );
                }

                const groupSelected = isModelSelectGroupSelected(
                  group,
                  normalizedValue,
                );
                return (
                  <Fragment key={group.key}>
                    {groupSeparator}
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger
                        className="min-h-8"
                        data-testid={testId(
                          TID_CHAT_MODEL_SELECT_GROUP,
                          group.key,
                        )}
                        data-model-provider-key={group.key}
                        data-model-provider-selected={
                          groupSelected ? "true" : undefined
                        }
                      >
                        {renderGroupLabel(group)}
                        {/* 供应商行只留右侧箭头（用户口径）：勾由子菜单里的模型项表示，
                            这一行重复打勾既挤又容易误读成「整个供应商被选中」。 */}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent
                        className={cn(
                          "max-h-72 overflow-y-auto",
                          // 固定宽度会提前截断模型名；按内容扩展，并让可用空间优先于最小宽度。
                          providerSubmenuClassName ??
                            "w-max min-w-[min(12rem,var(--radix-dropdown-menu-content-available-width))] max-w-(--radix-dropdown-menu-content-available-width)",
                        )}
                      >
                        {renderModelItems(group.items)}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </Fragment>
                );
              })
            : hasSelectableModel
              ? renderModelItems(modelGroups[0]?.items ?? [])
              : null}
          {renderedFooterActions.length > 0 ? (
            <div className="sticky bottom-0 z-10 bg-menu after:absolute after:left-0 after:top-full after:h-1 after:w-full after:bg-menu after:content-['']">
              {hasSelectableModel ? (
                <div
                  className={MENU_DIVIDER_CLASS}
                  aria-hidden="true"
                  style={{ marginLeft: 12, marginRight: 12 }}
                />
              ) : null}
              {renderedFooterActions.map((action) => (
                <DropdownMenuItem
                  key={action.key}
                  className="min-h-8 gap-2 px-2"
                  data-model-footer-action={action.key}
                  data-model-footer-action-selected={
                    action.selected ? "true" : undefined
                  }
                  onSelect={() => {
                    handlePopoverOpenChange(false);
                    action.onSelect?.();
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {action.label}
                  </span>
                  {action.selected ? (
                    <CheckIcon className="size-4 text-foreground-subtle" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </div>
          ) : null}
          {effort?.option && (effort.option.options?.length ?? 0) > 1 ? (
            <EffortSlider
              option={effort.option}
              onValueChange={effort.onValueChange}
              disabled={effort.disabled === true}
            />
          ) : null}
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  );
});
