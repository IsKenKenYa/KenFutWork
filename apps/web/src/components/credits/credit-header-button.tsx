// @credits-system — Header button showing credit balance + upgrade CTA (Lovart style)
"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, Gift, Zap } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCredits } from "@/hooks/use-credits";
import { useAuth } from "@/lib/auth-context";

// ── Plan badge color map ─────────────────────────────────────

const PLAN_COLORS: Record<string, string> = {
  free: "bg-secondary text-secondary-foreground",
  starter: "bg-primary text-primary-foreground",
  pro: "bg-primary text-primary-foreground",
  ultra: "bg-primary text-primary-foreground",
  business: "bg-primary text-primary-foreground",
};

// ── Main component ───────────────────────────────────────────

export function CreditHeaderButton() {
  const { user } = useAuth();
  const { balance, plan, dailyClaimed, limits, loading, claimDaily } =
    useCredits();

  const [open, setOpen] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Position popover below button
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPopoverStyle({
      position: "fixed",
      top: rect.bottom + 8,
      right: window.innerWidth - rect.right,
      zIndex: 9999,
    });
  }, [open]);

  const handleClaim = async () => {
    setClaiming(true);
    await claimDaily();
    setClaiming(false);
  };

  const isFree = plan === "free";
  const canClaim = isFree && !dailyClaimed;
  const avatarUrl = user?.user_metadata?.avatar_url as string | undefined;
  const displayName =
    (user?.user_metadata?.full_name as string | undefined) ??
    user?.email?.split("@")[0] ??
    "User";

  if (loading) {
    return (
      <div className="flex items-center gap-2">
        <div className="h-8 w-20 animate-pulse rounded-full bg-muted" />
      </div>
    );
  }

  return (
    <>
      <div ref={btnRef} className="flex items-center gap-2">
        {/* Upgrade button (non-business plans) */}
        {plan !== "business" && (
          <Link
            href="/pricing"
            className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Zap className="h-3 w-3 text-muted-foreground" />
            <span>升级</span>
          </Link>
        )}

        {/* Credit balance button */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-muted px-3 text-xs font-medium tabular-nums text-foreground transition-colors hover:bg-accent"
        >
          <Zap className="h-3 w-3 text-muted-foreground fill-muted-foreground" />
          <span>{balance.toLocaleString()}</span>
        </button>

        {/* User avatar */}
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={displayName}
            className="h-8 w-8 rounded-full border border-border object-cover"
          />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-muted text-xs font-medium text-muted-foreground">
            {displayName.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      {/* Popover */}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            <div ref={popoverRef} style={popoverStyle}>
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                className="w-72 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg"
              >
                {/* Plan badge + balance */}
                <div className="mb-3 flex items-center justify-between">
                  <span
                    className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${PLAN_COLORS[plan] ?? PLAN_COLORS.free}`}
                  >
                    {plan}
                  </span>
                  {limits && (
                    <span className="text-xs text-muted-foreground">
                      {isFree
                        ? `${limits.dailyCredits}/day`
                        : `${limits.monthlyCredits.toLocaleString()}/mo`}
                    </span>
                  )}
                </div>

                {/* Balance */}
                <div className="mb-3 flex items-center gap-2">
                  <Zap className="h-5 w-5 text-muted-foreground" />
                  <span className="text-2xl font-semibold tabular-nums text-foreground">
                    {balance.toLocaleString()}
                  </span>
                  <span className="text-xs text-muted-foreground">credits</span>
                </div>

                <div className="mb-3 h-px bg-border" />

                {/* Claim daily (free plan, unclaimed) */}
                {canClaim && (
                  <button
                    type="button"
                    onClick={handleClaim}
                    disabled={claiming}
                    className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg bg-success px-3 py-2 text-sm font-medium text-success-foreground transition-colors hover:bg-success/90 disabled:opacity-50"
                  >
                    {claiming ? (
                      <motion.div
                        className="h-4 w-4 rounded-full border-2 border-success-foreground/30 border-t-success-foreground"
                        animate={{ rotate: 360 }}
                        transition={{
                          duration: 0.6,
                          repeat: Infinity,
                          ease: "linear",
                        }}
                      />
                    ) : (
                      <Gift className="h-4 w-4" />
                    )}
                    {claiming ? "Claiming..." : "Claim Daily Credits"}
                  </button>
                )}

                {/* Already claimed */}
                {isFree && dailyClaimed && (
                  <div className="mb-3 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                    <Zap className="h-3.5 w-3.5 text-muted-foreground" />
                    Daily credits claimed
                  </div>
                )}

                {/* Usage details link */}
                <Link
                  href="/settings?tab=usage"
                  onClick={() => setOpen(false)}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
                >
                  <span>Usage Details</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </Link>
              </motion.div>
            </div>
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
