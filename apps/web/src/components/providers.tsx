"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

import {
  LocalInstanceBoundary,
  LocalInstanceProvider,
} from "../lib/local-instance-context";
import { ToastProvider } from "./toast";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <LocalInstanceProvider>
        <ToastProvider>
          <LocalInstanceBoundary>{children}</LocalInstanceBoundary>
        </ToastProvider>
      </LocalInstanceProvider>
    </ThemeProvider>
  );
}
