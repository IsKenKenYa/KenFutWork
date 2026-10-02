"use client";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useState,
} from "react";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@/lib/panel-layout";
export function useSidebarWidth() {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined") return 256;
    const saved = Number(
      window.localStorage.getItem("workbench:sidebar-width"),
    );
    return Number.isFinite(saved) &&
      saved >= MIN_SIDEBAR_WIDTH &&
      saved <= MAX_SIDEBAR_WIDTH
      ? saved
      : 256;
  });

  const startSidebarResize = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      const clamp = (next: number) =>
        Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, next));
      const onMove = (moveEvent: MouseEvent) => {
        setSidebarWidth(clamp(startWidth + (moveEvent.clientX - startX)));
      };
      const onUp = (upEvent: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.localStorage.setItem(
          "workbench:sidebar-width",
          String(clamp(startWidth + (upEvent.clientX - startX))),
        );
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );
  return { sidebarWidth, startSidebarResize };
}
