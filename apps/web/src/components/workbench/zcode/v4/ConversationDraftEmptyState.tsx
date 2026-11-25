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
 * 路径由 `kenfutwork-mark.png` **整条轮廓**自动提取（matplotlib contour，单条闭合环）。
 * 不要改成「按行切块拼多边形」：那种做法在中缝（左右两块视觉相接处）会凭空造出
 * 一条横穿整幅的直线，看起来就是「这边断了」（用户 2026-11-24 反馈）。
 * 改图时重跑 `.scratch/extract-mark-mpl.py`，不要手改坐标。
 */
const MARK_PATH = [
  "M 53.23 22.36 L 62.19 22.79 L 70.65 24.69 L 79.10 28.31",
  "L 86.07 32.73 L 95.64 42.27 L 99.73 48.73 L 103.17 56.70",
  "L 105.09 63.66 L 106.04 73.61 L 106.47 173.43 L 110.45 162.69",
  "L 114.87 154.72 L 122.62 144.27 L 129.85 136.50 L 202.99 63.60",
  "L 214.43 55.03 L 227.36 48.10 L 239.30 44.55 L 251.24 43.38",
  "L 388.56 43.20 L 393.03 44.09 L 396.54 46.74 L 398.75 51.72",
  "L 398.18 61.67 L 394.64 73.61 L 389.15 85.56 L 380.19 99.49",
  "L 373.13 108.14 L 364.68 116.54 L 353.23 125.51 L 344.28 130.90",
  "L 334.33 135.46 L 324.38 138.89 L 312.44 141.41 L 243.78 142.77",
  "L 233.33 145.15 L 219.40 152.15 L 206.51 162.68 L 195.91 175.62",
  "L 190.41 188.06 L 190.05 197.75 L 205.47 187.49 L 219.40 180.87",
  "L 233.83 176.94 L 244.28 175.88 L 347.26 175.96 L 354.23 178.06",
  "L 359.86 183.58 L 361.52 190.05 L 360.77 198.51 L 357.29 208.46",
  "L 352.83 217.42 L 346.81 226.87 L 339.89 235.33 L 332.84 241.95",
  "L 324.38 247.31 L 315.42 250.90 L 305.47 252.51 L 229.60 252.74",
  "L 312.08 353.26 L 314.60 358.73 L 315.10 364.70 L 313.59 369.68",
  "L 309.95 373.82 L 306.47 375.74 L 301.00 376.86 L 235.32 376.79",
  "L 223.54 373.66 L 210.95 365.74 L 203.32 357.73 L 162.98 305.49",
  "L 131.67 260.71 L 122.70 245.78 L 115.81 231.85 L 109.95 217.30",
  "L 105.97 204.45 L 105.92 329.37 L 103.69 341.31 L 97.64 353.75",
  "L 88.38 364.70 L 77.61 372.22 L 65.67 376.74 L 54.73 378.05",
  "L 42.29 376.72 L 28.36 371.20 L 19.40 364.64 L 10.81 354.75",
  "L 4.37 341.81 L 1.68 327.38 L 1.94 69.14 L 4.39 58.69",
  "L 8.35 49.73 L 13.43 42.44 L 19.40 36.24 L 25.87 31.22",
  "L 35.32 26.26 L 42.79 23.77 Z",
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

            渐隐（用户口径 2026-11-24 两轮）：第一轮把淡出压到 82% 仍嫌靠下，
            「需要再往上一点」——改为 `black 0% → black 44% → transparent 68%`：
            44% 开始淡出、68% 全透明，K 的下半段在问候语上方就已经收干净。 */}
        <svg
          aria-hidden="true"
          data-v4-draft-logo="outline"
          className={cn(
            className,
            "h-full w-full object-contain",
            "[-webkit-mask-image:linear-gradient(to_bottom,black_0%,black_44%,transparent_68%)]",
            "[-webkit-mask-repeat:no-repeat] [-webkit-mask-size:100%_100%]",
            "[mask-image:linear-gradient(to_bottom,black_0%,black_44%,transparent_68%)]",
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
            d={MARK_PATH}
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
