"use client";

import type { VideoGenerationPreference } from "@kenfutwork/shared";
import { useCallback, useSyncExternalStore } from "react";
import { toggleMediaModel } from "./mediaModelPreference.js";

const STORAGE_KEY = "kenfutwork:video-model-preference";

export type VideoModelPreference = VideoGenerationPreference;

const defaultPreference: VideoModelPreference = {
  mode: "auto",
  models: [],
};

const listeners = new Set<() => void>();
function emitChange() {
  for (const listener of listeners) listener();
}

let cachedRaw: string | null = null;
let cachedPreference: VideoModelPreference = defaultPreference;

export function readVideoModelPreference(): VideoModelPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== cachedRaw) {
      const next = raw
        ? normalizePreference(
            JSON.parse(raw) as Partial<VideoModelPreference> & {
              model?: string;
            },
          )
        : defaultPreference;
      // 赋值放在 parse/normalize 成功之后：坏 JSON 抛异常时不污染缓存，
      // 下次读取重新解析而不是命中 raw === cachedRaw 快路径返回旧偏好。
      cachedRaw = raw;
      cachedPreference = next;
    }
    return cachedPreference;
  } catch {
    return defaultPreference;
  }
}

function getServerSnapshot(): VideoModelPreference {
  return defaultPreference;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function normalizePreference(
  preference?: Partial<VideoModelPreference> & { model?: string },
): VideoModelPreference {
  if (!preference) return defaultPreference;

  const models = Array.isArray(preference.models)
    ? preference.models.filter(
        (model): model is string =>
          typeof model === "string" && model.length > 0,
      )
    : typeof preference.model === "string" && preference.model.length > 0
      ? [preference.model]
      : defaultPreference.models;

  return {
    mode: preference.mode === "manual" ? "manual" : "auto",
    models: models.length > 0 ? models : defaultPreference.models,
  };
}

export function useVideoModelPreference() {
  const preference = useSyncExternalStore(
    subscribe,
    readVideoModelPreference,
    getServerSnapshot,
  );

  const setPreference = useCallback((next: VideoModelPreference) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    emitChange();
  }, []);

  const setMode = useCallback(
    (mode: "auto" | "manual") => {
      setPreference({ ...preference, mode });
    },
    [preference, setPreference],
  );

  const toggleModel = useCallback(
    (model: string) => {
      const next = toggleMediaModel(preference, model);
      if (next !== preference) setPreference(next);
    },
    [preference, setPreference],
  );

  const activeVideoGenerationPreference =
    preference.mode === "manual" && preference.models.length > 0
      ? preference
      : undefined;

  return {
    preference,
    setPreference,
    setMode,
    toggleModel,
    activeVideoGenerationPreference,
  };
}
