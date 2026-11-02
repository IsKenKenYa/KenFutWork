/**
 * 草稿态空态问候：时间问候语 + ZCode Logo。
 * 自旧版 ChatView/ChatViewEmptyState.tsx 恢复（该组件随旧 ChatView 删除，
 * i18n key `chat.empty.greeting.*` 一直保留）；边界时刻自动换档逻辑保真。
 * 手机远控复用同一组件，但继续保留 20px 紧凑标题；桌面草稿首页才按标题自身宽度适配。
 */

import kenfutworkMarkUrl from "@zui/assets/kenfutwork-mark.png";
import { cn } from "@zui/components/lib/utils.js";
import { useIsOfficeMode } from "@zui/hooks/useInterfaceMode.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { logger } from "@zui/logger.js";
import { Briefcase, Code2, Palette } from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useId,
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

export function ConversationDraftEmptyState({
  className,
}: {
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  // 线稿描边滤镜 id：组件可能多处挂载（手机远控复用），id 不能撞
  const outlineFilterId = `kfw-mark-outline-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
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
  const HeroIcon = designHero ? Palette : workbenchMode === "work" ? Briefcase : Code2;
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
          "pointer-events-none absolute left-1/2 top-1/2 aspect-[5/4] w-[min(72vw,25rem)] -mt-10",
          "-translate-x-1/2 -translate-y-1/2 text-foreground-subtlest",
        )}
      >
        {/* 以 Code 原版空态样式为基底，只换标：
            浅色 = KenFutWork 标的线稿描边（feMorphology 内缩/外扩取环，currentColor 同原 Z 线稿的浅淡口径）；
            暗色 = 白色标（brightness-0 invert 取纯白剪影）。两套同款向下渐隐遮罩。 */}
        <svg
          aria-hidden="true"
          data-v4-draft-logo="light"
          className={cn(
            className,
            "h-full w-full object-contain opacity-45",
            "[-webkit-mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)]",
            "[-webkit-mask-repeat:no-repeat] [-webkit-mask-size:100%_100%]",
            "[mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)]",
            "[mask-repeat:no-repeat] [mask-size:100%_100%]",
          )}
          viewBox="0 0 400 400"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <filter
            id={outlineFilterId}
            x="-10%"
            y="-10%"
            width="120%"
            height="120%"
          >
            <feMorphology
              in="SourceAlpha"
              operator="dilate"
              radius="1.5"
              result="kfw-dil"
            />
            <feMorphology
              in="SourceAlpha"
              operator="erode"
              radius="1.5"
              result="kfw-ero"
            />
            <feComposite
              in="kfw-dil"
              in2="kfw-ero"
              operator="xor"
              result="kfw-ring"
            />
            <feFlood floodColor="currentColor" />
            <feComposite in2="kfw-ring" operator="in" />
          </filter>
          <image
            href={kenfutworkMarkUrl}
            width="400"
            height="400"
            preserveAspectRatio="xMidYMax meet"
            filter={`url(#${outlineFilterId})`}
          />
        </svg>
        {/* 暗色：白色标剪影（原暗色 Z.svg 的渐变贴图口径换成纯白，同一渐隐遮罩） */}
        {/* biome-ignore lint/performance/noImgElement: output: "export" 未开 images.unoptimized，next/image 会构建失败 */}
        <img
          aria-hidden="true"
          data-v4-draft-logo="dark"
          src={kenfutworkMarkUrl}
          alt=""
          draggable={false}
          className={cn(
            className,
            "h-full w-full object-contain object-bottom opacity-30 brightness-0 invert",
            "[-webkit-mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)]",
            "[-webkit-mask-repeat:no-repeat] [-webkit-mask-size:100%_100%]",
            "[mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)]",
            "[mask-repeat:no-repeat] [mask-size:100%_100%]",
          )}
        />
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
