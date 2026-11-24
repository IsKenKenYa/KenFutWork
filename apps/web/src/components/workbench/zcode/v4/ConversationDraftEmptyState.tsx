/**
 * 草稿态空态问候：时间问候语 + ZCode Logo。
 * 自旧版 ChatView/ChatViewEmptyState.tsx 恢复（该组件随旧 ChatView 删除，
 * i18n key `chat.empty.greeting.*` 一直保留）；边界时刻自动换档逻辑保真。
 * 手机远控复用同一组件，但继续保留 20px 紧凑标题；桌面草稿首页才按标题自身宽度适配。
 */

import { cn } from "@zui/components/lib/utils.js";
import { useIsOfficeMode } from "@zui/hooks/useInterfaceMode.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { logger } from "@zui/logger.js";
import { Briefcase, Code2, Palette } from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

const GREETING_BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23] as const;
const GREETING_MIN_FONT_SIZE_PX = 20;
const GREETING_MAX_FONT_SIZE_PX = 36;
/** 标题左侧图标在字号上限时的边长（原 `size-10`）；随字号等比缩放，不单独定尺寸。 */
const GREETING_ICON_MAX_PX = 40;

type ChatEmptyGreetingMessageId =
  | "chat.empty.greeting.morningEarly"
  | "chat.empty.greeting.morning"
  | "chat.empty.greeting.noon"
  | "chat.empty.greeting.afternoon"
  | "chat.empty.greeting.evening"
  | "chat.empty.greeting.lateNight";

function getChatEmptyGreetingMessageId(
  date: Date = new Date(),
): ChatEmptyGreetingMessageId {
  const hour = date.getHours();

  if (hour >= 5 && hour < 9) return "chat.empty.greeting.morningEarly";
  if (hour >= 9 && hour < 12) return "chat.empty.greeting.morning";
  if (hour >= 12 && hour < 14) return "chat.empty.greeting.noon";
  if (hour >= 14 && hour < 18) return "chat.empty.greeting.afternoon";
  if (hour >= 18 && hour < 23) return "chat.empty.greeting.evening";

  return "chat.empty.greeting.lateNight";
}

function getNextChatEmptyGreetingDelayMs(date: Date = new Date()) {
  const candidates = GREETING_BOUNDARY_HOURS.map((hour) => {
    const boundary = new Date(date);
    boundary.setHours(hour, 0, 0, 0);
    return boundary;
  });
  const tomorrowFirstBoundary = new Date(date);
  tomorrowFirstBoundary.setDate(tomorrowFirstBoundary.getDate() + 1);
  tomorrowFirstBoundary.setHours(GREETING_BOUNDARY_HOURS[0], 0, 0, 0);

  const nextBoundary =
    candidates.find((candidate) => candidate.getTime() > date.getTime()) ??
    tomorrowFirstBoundary;

  return Math.max(1, nextBoundary.getTime() - date.getTime());
}

function resolveGreetingFontSizePx({
  availableWidthPx,
  naturalTextWidthPx,
}: {
  availableWidthPx: number;
  naturalTextWidthPx: number;
}) {
  if (
    !Number.isFinite(availableWidthPx) ||
    !Number.isFinite(naturalTextWidthPx) ||
    availableWidthPx <= 0 ||
    naturalTextWidthPx <= 0 ||
    availableWidthPx >= naturalTextWidthPx
  ) {
    return GREETING_MAX_FONT_SIZE_PX;
  }

  return Math.max(
    GREETING_MIN_FONT_SIZE_PX,
    Math.min(
      GREETING_MAX_FONT_SIZE_PX,
      Math.floor(
        GREETING_MAX_FONT_SIZE_PX * (availableWidthPx / naturalTextWidthPx),
      ),
    ),
  );
}

/**
 * 空态背景那个「半个 K」的轮廓路径（viewBox 400×400）。
 *
 * 为什么从位图换成矢量路径：原来用 `<image>` 引 PNG、再用 `feMorphology` 在 alpha 上
 * 取一圈环当描边。位图每处笔画的粗细与抗锯齿不同，取出来的环宽就跟着变——同一张图上
 * 实测 1.33px 到 20px 都有，用户反复反馈「粗细不统一」。矢量路径配 `stroke-width`
 * 是一笔常量宽度，任何位置都一样。
 *
 * 路径由 `kenfutwork-mark.png` 自动提取（逐行扫描 alpha 区间拼轮廓），
 * 三段对应原图的三块形状：左竖条、右上斜块、右下斜块。改图时重跑提取脚本即可，
 * 不要手改坐标。
 */
const KENFUTWORK_MARK_PATH = [
  // 左侧竖条
  "M 47.70 22.86 L 31.80 27.83 L 19.88 35.78 L 8.94 48.70",
  "L 4.97 57.14 L 1.99 68.57 L 1.99 330.93 L 3.48 338.39",
  "L 8.45 350.31 L 15.90 360.75 L 23.85 367.70 L 33.29 373.17",
  "L 40.25 375.65 L 47.20 377.14 L 60.62 377.14 L 75.53 372.67",
  "L 86.46 365.71 L 93.42 358.76 L 99.88 349.32 L 105.34 333.42",
  "L 105.34 204.72 L 107.83 204.22 L 107.83 173.42 L 105.84 172.92",
  "L 105.84 72.05 L 104.35 61.12 L 101.86 53.66 L 95.40 42.24",
  "L 87.95 34.29 L 79.01 28.32 L 71.06 24.84 L 62.61 22.86",
  "Z",
  // 右上斜块
  "M 313.54 43.23 L 244.47 43.73 L 227.08 48.20 L 213.17 55.65",
  "L 202.73 63.60 L 121.74 145.09 L 114.78 154.53 L 108.32 166.96",
  "L 106.83 171.43 L 108.32 175.40 L 195.28 175.40 L 200.75 167.95",
  "L 212.67 156.52 L 225.59 148.07 L 235.53 144.10 L 243.48 142.61",
  "L 312.55 141.12 L 328.94 137.14 L 349.81 127.20 L 363.23 117.27",
  "L 373.66 106.83 L 385.09 91.43 L 392.55 77.52 L 396.02 68.07",
  "L 398.01 59.63 L 397.52 49.19 L 395.03 45.71 L 391.55 43.73",
  "Z",
  // 右下斜块
  "M 240.99 175.90 L 230.56 177.39 L 215.16 182.36 L 204.22 187.83",
  "L 190.31 197.27 L 108.32 197.76 L 108.32 204.22 L 106.34 204.72",
  "L 107.83 210.68 L 118.76 238.01 L 132.17 261.37 L 165.47 308.57",
  "L 202.73 356.77 L 210.68 365.22 L 221.12 372.17 L 234.04 376.15",
  "L 304.60 375.65 L 309.07 373.66 L 313.54 368.20 L 314.53 360.25",
  "L 312.55 354.29 L 286.71 321.49 L 229.07 252.42 L 308.07 251.93",
  "L 315.53 250.43 L 323.98 246.96 L 331.93 241.99 L 340.37 234.04",
  "L 351.80 218.14 L 359.75 200.25 L 360.75 195.78 L 360.25 185.34",
  "L 355.28 178.88 L 347.83 175.90 Z",
].join(" ");

export function ConversationDraftEmptyState({
  className,
}: {
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  // Design 是壳内主区视图，原树 interfaceMode 恒为 coding，标题只能读工作台模式。
  const workbenchNavigation = useOptionalPlatform()?.workbenchNavigation;
  const workbenchMode = useSyncExternalStore(
    workbenchNavigation?.subscribe ?? (() => () => {}),
    () => workbenchNavigation?.getSnapshot().mode ?? "code",
  );
  const designHero = workbenchMode === "design";
  // 空态命名跟随工作台模式：三个模式共用同一会话主区，标题不能一律挂 Code 名号。
  const heroLabel =
    workbenchMode === "design"
      ? "Design with KenFutWork"
      : workbenchMode === "work"
        ? "Work with KenFutWork"
        : "Code with KenFutWork";
  const HeroIcon = designHero
    ? Palette
    : workbenchMode === "work"
      ? Briefcase
      : Code2;
  const [greetingDate, setGreetingDate] = useState(() => new Date());
  const [greetingFontSizePx, setGreetingFontSizePx] = useState(
    GREETING_MAX_FONT_SIZE_PX,
  );
  const greetingContainerRef = useRef<HTMLParagraphElement | null>(null);
  const greetingRowRef = useRef<HTMLDivElement | null>(null);
  const greetingMeasurementRef = useRef<HTMLSpanElement | null>(null);
  const greeting = intl.formatMessage({
    id: isOfficeMode
      ? "chat.empty.greeting.office"
      : getChatEmptyGreetingMessageId(greetingDate),
  });
  // 图标跟着标题字号等比缩放：字号缩到 20px 时图标仍是 40px 会显得头重脚轻，
  // 也是用户说的「画板不跟着变小」。
  const greetingIconPx = Math.round(
    (GREETING_ICON_MAX_PX * greetingFontSizePx) / GREETING_MAX_FONT_SIZE_PX,
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setGreetingDate(new Date());
    }, getNextChatEmptyGreetingDelayMs(greetingDate));

    return () => {
      window.clearTimeout(timeout);
    };
  }, [greetingDate]);

  useLayoutEffect(() => {
    const container = greetingContainerRef.current;
    const measurement = greetingMeasurementRef.current;
    if (!container || !measurement) {
      return;
    }

    let frameId: number | null = null;
    const measure = () => {
      frameId = null;
      const containerStyle = window.getComputedStyle(container);
      const horizontalPaddingPx =
        Number.parseFloat(containerStyle.paddingLeft) +
        Number.parseFloat(containerStyle.paddingRight);
      const row = greetingRowRef.current;
      const rowGapPx = row
        ? Number.parseFloat(window.getComputedStyle(row).columnGap) || 0
        : 0;
      // 可用宽必须扣掉「图标 + 间距」：只按文字宽判会以为放得下，实际整行
      // 顶出内容区，左边吃掉 padding、右边剩下滚动条留白——看起来就是没居中。
      const availableWidthPx = Math.max(
        0,
        container.getBoundingClientRect().width -
          horizontalPaddingPx -
          GREETING_ICON_MAX_PX -
          rowGapPx,
      );
      const naturalTextWidthPx = measurement.getBoundingClientRect().width;
      const nextFontSizePx = resolveGreetingFontSizePx({
        availableWidthPx,
        naturalTextWidthPx,
      });

      setGreetingFontSizePx((currentFontSizePx) => {
        if (currentFontSizePx === nextFontSizePx) {
          return currentFontSizePx;
        }
        logger.debug("[v4-draft-greeting] 标题自身可用宽度变化，更新字号", {
          availableWidthPx: Math.round(availableWidthPx),
          naturalTextWidthPx: Math.round(naturalTextWidthPx),
          previousFontSizePx: currentFontSizePx,
          nextFontSizePx,
        });
        return nextFontSizePx;
      });
    };
    const scheduleMeasure = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(measure);
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleMeasure);
      return () => {
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
        }
        window.removeEventListener("resize", scheduleMeasure);
      };
    }

    // 标题字号曾直接绑定整个视口宽度，最小窗口里文字两侧仍有大量空间却被
    // 强制缩到 20px。这里只观察容器：测量用的 <span> 字号已固定在 36px，
    // 宽度不再随字号变化，观察它等于把「字号」接回「字号」的输入端。
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(container);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [greeting]);

  return (
    <div
      className={cn(
        "relative mb-10 flex w-full max-w-2xl flex-col items-center justify-center gap-6 text-foreground sm:mb-8",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          // 尺寸与位置（用户口径 2026-11-24「露出多一点」）：原先 25rem 且渐隐从 55%
          // 就开始，只剩上半截。改为 26rem、渐隐推到 72%，整块 K 的结构看得清，
          // 又不至于压到问候语与下方控件。
          "pointer-events-none absolute left-1/2 top-1/2 aspect-[5/4] w-[min(74vw,26rem)] -mt-12",
          "-translate-x-1/2 -translate-y-1/2",
        )}
      >
        {/* 用户口径：对话面板背景那「半个 K」一律用线稿，暗色也不再是白色实心剪影。
            深浅同款一张 SVG，描边颜色与不透明度由 styles.css 按 .dark 切换。
            渐隐遮罩保留但**大幅后移**（55% → 88%）：原来太早开始淡出，用户看不出
            这是一整块 K；现在只在最底部收一点，避免压到问候语。 */}
        <svg
          aria-hidden="true"
          data-v4-draft-logo="outline"
          className={cn(
            className,
            "h-full w-full object-contain",
            "[-webkit-mask-image:linear-gradient(to_bottom,black_0%,black_72%,transparent_100%)]",
            "[-webkit-mask-repeat:no-repeat] [-webkit-mask-size:100%_100%]",
            "[mask-image:linear-gradient(to_bottom,black_0%,black_72%,transparent_100%)]",
            "[mask-repeat:no-repeat] [mask-size:100%_100%]",
          )}
          viewBox="0 0 400 400"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* 线宽（用户口径 2026-11-24 三轮）：
              粗细**统一**只能靠矢量描边。此前这里是 PNG 位图 + feMorphology 取环，
              环宽随原图每处笔画的粗细与抗锯齿变化（同一张图上实测 1.33px 到 20px
              都有），所以永远「粗细不统一」。
              现在改为矢量路径 + stroke-width：一笔常量宽度，任何位置都一样。
              0.9 是用户圈出那一段的粗细。 */}
          <path
            d={KENFUTWORK_MARK_PATH}
            fill="none"
            stroke="currentColor"
            strokeWidth={0.9}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div
        ref={greetingContainerRef}
        data-v4-draft-greeting="true"
        style={
          {
            "--v4-draft-greeting-font-size": `${greetingFontSizePx}px`,
          } as CSSProperties
        }
        className="relative z-10 flex w-full flex-col items-center justify-center gap-2 text-muted-foreground/50"
      >
        {/* 用户口径：空态用命名式标题（「Code / Design with KenFutWork」，font-wordmark +
            tracking-tight），时间问候语降为次行小字；Design 视图下换 Design 名号与调色板图标。 */}
        <div
          ref={greetingRowRef}
          className="flex items-center justify-center gap-3"
        >
          <HeroIcon
            className="shrink-0"
            strokeWidth={3}
            style={{ width: greetingIconPx, height: greetingIconPx }}
          />
          <p
            style={
              {
                fontSize: "var(--v4-draft-greeting-font-size)",
                lineHeight: 1.2,
              } as CSSProperties
            }
            className="relative whitespace-nowrap font-wordmark font-medium tracking-tight"
          >
            <span
              ref={greetingMeasurementRef}
              aria-hidden="true"
              // 基准字号固定为上限：这里量的是「36px 下这段文案有多宽」。
              // 若让它继承 <p> 的当前字号，量出来的宽度会随字号变，
              // 于是 字号→宽度→字号 自激振荡（实测 36px↔21px 每帧来回，标题左右跳动）。
              style={{ fontSize: GREETING_MAX_FONT_SIZE_PX }}
              className="pointer-events-none invisible absolute whitespace-nowrap"
            >
              {heroLabel}
            </span>
            {heroLabel}
          </p>
        </div>
        <p className="text-sm text-muted-foreground/70">{greeting}</p>
      </div>
    </div>
  );
}
