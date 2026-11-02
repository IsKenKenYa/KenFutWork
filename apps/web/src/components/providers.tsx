"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

import { InstanceThemeSync } from "../lib/instance-theme";
import {
  LocalInstanceBoundary,
  LocalInstanceProvider,
} from "../lib/local-instance-context";
import { ToastProvider } from "./toast";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <LocalInstanceProvider>
        <InstanceThemeSync />
        <ToastProvider>
          <LocalInstanceBoundary>{children}</LocalInstanceBoundary>
        </ToastProvider>
      </LocalInstanceProvider>
    </ThemeProvider>
  );
}
