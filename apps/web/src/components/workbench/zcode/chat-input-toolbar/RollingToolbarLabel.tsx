/**
 * zcode 照搬：`@/chat-input-toolbar/RollingToolbarLabel.tsx`（references/zcode/packages/ui/src/chat-input-toolbar/RollingToolbarLabel.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀；P5 适配：可选属性放宽 `| undefined`（exactOptionalPropertyTypes，照搬调用点显式传 undefined）
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */

import { cn } from "@zui/components/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

const LABEL_ROLL_TRANSITION = {
  duration: 0.2,
  ease: [0.4, 0, 0.2, 1],
} as const;

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(query.matches);
    };
    update();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => {
        query.removeEventListener("change", update);
      };
    }

    query.addListener(update);
    return () => {
      query.removeListener(update);
    };
  }, []);

  return prefersReducedMotion;
}

export function RollingToolbarLabel({
  label,
  className,
  prefix,
  prefixClassName,
  value,
}: {
  label: string;
  className?: string | undefined;
  prefix?: string | undefined;
  prefixClassName?: string | undefined;
  value?: string | undefined;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const content =
    prefix !== undefined && value !== undefined ? (
      <>
        <span className={prefixClassName}>{prefix}</span>
        <span>{value}</span>
      </>
    ) : (
      label
    );

  if (reducedMotion) {
    return (
      <span className={className} title={label}>
        {content}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "relative inline-flex h-[1.3em] min-w-0 items-center overflow-hidden leading-[1.25]",
        className,
      )}
      title={label}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={label}
          className="inline-flex min-w-0 whitespace-nowrap leading-[1.25]"
          initial={{ y: "0.75em", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "-0.75em", opacity: 0 }}
          transition={LABEL_ROLL_TRANSITION}
        >
          {content}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
