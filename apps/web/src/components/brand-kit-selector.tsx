"use client";

import type { BrandKitSummary } from "@kenfutwork/shared";
import { Check, ChevronDown, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBrandKits } from "@/lib/brand-kit-api";
import { updateProject } from "@/lib/server-api";

interface BrandKitSelectorProps {
  accessToken: string | null;
  projectId: string;
  currentBrandKitId: string | null;
  onBrandKitChange: (kitId: string | null) => void;
  /** 「管理品牌套件…」的回调：由画布页开浮窗；不传则退化为导航到 /brand-kit。 */
  onManage?: (() => void) | undefined;
}

export function BrandKitSelector({
  accessToken,
  projectId,
  currentBrandKitId,
  onBrandKitChange,
  onManage,
}: BrandKitSelectorProps) {
  const [kits, setKits] = useState<BrandKitSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Use a ref for accessToken to prevent tab-switch reload cascades.
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  // Fetch brand kits on mount
  useEffect(() => {
    let cancelled = false;
    fetchBrandKits(accessTokenRef.current)
      .then((res) => {
        if (!cancelled) setKits(res.brandKits);
      })
      .catch(() => {
        /* silently ignore – selector stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const currentKit = kits.find((k) => k.id === currentBrandKitId);
  const label = currentKit ? currentKit.name : "品牌套件: 无";

  const handleSelect = useCallback(
    async (kitId: string | null) => {
      if (kitId === currentBrandKitId) {
        setOpen(false);
        return;
      }
      setUpdating(true);
      try {
        await updateProject(accessTokenRef.current, projectId, {
          brand_kit_id: kitId,
        });
        onBrandKitChange(kitId);
      } catch {
        /* keep current state on failure */
      } finally {
        setUpdating(false);
        setOpen(false);
      }
    },
    [projectId, currentBrandKitId, onBrandKitChange],
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={updating}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-xl bg-card border border-border shadow-sm px-3 py-1.5 text-sm transition-colors hover:bg-card disabled:opacity-50"
      >
        <span className="truncate max-w-[120px]">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 min-w-[180px] rounded-xl border bg-popover shadow-lg p-1.5">
          {/* Unbind option */}
          <button
            type="button"
            onClick={() => handleSelect(null)}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-muted transition-colors cursor-pointer"
          >
            <span className="h-4 w-4 shrink-0">
              {currentBrandKitId === null && <Check className="h-4 w-4" />}
            </span>
            <span>无</span>
          </button>

          {/* Kit list */}
          {kits.map((kit) => (
            <button
              key={kit.id}
              type="button"
              onClick={() => handleSelect(kit.id)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-muted transition-colors cursor-pointer"
            >
              <span className="h-4 w-4 shrink-0">
                {kit.id === currentBrandKitId && <Check className="h-4 w-4" />}
              </span>
              <span className="truncate">{kit.name}</span>
            </button>
          ))}

          {kits.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              暂无品牌套件
            </p>
          )}

          {/* 管理入口：改为画布内的浮窗（onManage 由画布页提供）。
              此前是导航到 /brand-kit——画布跑在 iframe 里，导航会把整页换掉，
              用户反馈「跳走」；未传回调时保留原导航行为兜底。 */}
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              if (onManage) {
                onManage();
                return;
              }
              const top = window.top ?? window;
              try {
                top.location.assign("/brand-kit");
              } catch {
                window.location.assign("/brand-kit");
              }
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-muted transition-colors cursor-pointer"
          >
            <Settings2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
            <span>管理品牌套件…</span>
          </button>
        </div>
      )}
    </div>
  );
}
