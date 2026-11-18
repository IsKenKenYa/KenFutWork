"use client";

import { useCallback } from "react";
import { useToast } from "@/components/toast";
import { ApiApplicationError } from "@/lib/server-api";

export function useGenerationErrorHandler() {
  const { error: showErrorToast } = useToast();
  const handleGenerationError = useCallback(
    (error: unknown): boolean => {
      showErrorToast(
        error instanceof ApiApplicationError
          ? error.message
          : "生成失败，请重试。",
      );
      return false;
    },
    [showErrorToast],
  );
  return { handleGenerationError };
}
