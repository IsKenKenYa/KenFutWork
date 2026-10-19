import { parseLocalWorkspaceIdentity } from "@zcode/shared";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import type { ComposerContextHeaderProps } from "@zui/v4/composer/ComposerContext.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  CANVAS_DOCUMENT_DELETED_EVENT,
  type CanvasDocumentDeleted,
} from "./canvasDocumentNavigation.js";
import {
  canvasConversationContextRevision,
  getCanvasConversationContext,
  subscribeCanvasConversationContext,
  withoutCanvasContext,
} from "./conversationWorkContext.js";
import {
  type MediaModelInfo,
  MediaModelPreferencePopover,
} from "./media/MediaModelPreferencePopover.js";
import type { MediaModelPreference } from "./media/mediaModelPreference.js";
import { surfaceJson } from "./surfaceApi.js";

const loadImages: () => Promise<{ models: MediaModelInfo[] }> = () =>
  surfaceJson("/api/image-models");
const loadVideos: () => Promise<{ models: MediaModelInfo[] }> = () =>
  surfaceJson("/api/video-models");

export function ConversationWorkContextHeader({
  workspaceIdentity,
  workspacePath,
  contextOverride,
  onChangeContext,
}: ComposerContextHeaderProps) {
  const platform = useOptionalPlatform();
  const draft = useRef({ contextOverride, onChangeContext });
  draft.current = { contextOverride, onChangeContext };
  const onUseCurrentContext = () => onChangeContext(undefined);
  const onRemoveCanvas = () => {
    const context =
      contextOverride ??
      platform?.getConversationWorkContext?.({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
    if (context) onChangeContext(withoutCanvasContext(context));
  };
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [referenceName, setReferenceName] = useState<{
    id: string;
    name: string;
  } | null>(null);
  useSyncExternalStore(
    subscribeCanvasConversationContext,
    canvasConversationContextRevision,
  );
  const navigation = useOptionalPlatform()?.workbenchNavigation;
  const mode = useSyncExternalStore(
    navigation?.subscribe ?? (() => () => {}),
    () => navigation?.getSnapshot().mode ?? "code",
  );
  const projectId = parseLocalWorkspaceIdentity(
    workspaceIdentity ?? "",
    workspacePath,
  )?.projectId;
  const canvas =
    mode === "design" && projectId
      ? getCanvasConversationContext(projectId)
      : null;
  const canvasId = contextOverride
    ? contextOverride.canvasId
    : canvas?.canvasId;
  const brandKitId = contextOverride
    ? contextOverride.brandKitId
    : canvas?.brandKitId;
  useEffect(() => {
    if (!canvasId || !projectId || canvas?.canvasId === canvasId) return;
    let active = true;
    void surfaceJson<{ canvases: Array<{ id: string; name: string }> }>(
      `/api/projects/${encodeURIComponent(projectId)}/canvases`,
    )
      .then((response) => {
        const found = response.canvases.find((item) => item.id === canvasId);
        if (active && found)
          setReferenceName({ id: canvasId, name: found.name });
        if (
          active &&
          !found &&
          draft.current.contextOverride?.canvasId === canvasId
        )
          draft.current.onChangeContext(
            withoutCanvasContext(draft.current.contextOverride),
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [canvasId, projectId, canvas?.canvasId]);
  useEffect(() => {
    const deleted = (event: Event) => {
      const target = (event as CustomEvent<CanvasDocumentDeleted>).detail;
      const context = draft.current.contextOverride;
      if (
        target &&
        projectId &&
        target.projectId === projectId &&
        context?.canvasId === target.canvasId
      )
        draft.current.onChangeContext(withoutCanvasContext(context));
    };
    window.addEventListener(CANVAS_DOCUMENT_DELETED_EVENT, deleted);
    return () =>
      window.removeEventListener(CANVAS_DOCUMENT_DELETED_EVENT, deleted);
  }, [projectId]);
  if (!canvasId && !brandKitId && mode !== "design" && !contextOverride)
    return null;
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-xs">
      {contextOverride ? (
        <>
          <span>{contextOverride.preset === "design" ? "Design" : "Code"}</span>
          <button type="button" onClick={onUseCurrentContext}>
            当前上下文
          </button>
        </>
      ) : null}
      {canvasId ? (
        <>
          <span className="min-w-0 truncate">
            {canvas?.canvasId === canvasId
              ? canvas.title
              : referenceName?.id === canvasId
                ? referenceName.name
                : "画布"}
          </span>
          <button
            type="button"
            aria-label="移除画布引用"
            onClick={onRemoveCanvas}
          >
            ×
          </button>
        </>
      ) : null}
      {brandKitId ? <span>品牌素材</span> : null}
      {mode === "design" || contextOverride?.preset === "design" ? (
        <>
          <button
            type="button"
            ref={anchorRef}
            onClick={() => setPreferencesOpen(!preferencesOpen)}
          >
            媒体模型
          </button>
          <MediaModelPreferencePopover
            open={preferencesOpen}
            onClose={() => setPreferencesOpen(false)}
            anchorRef={anchorRef}
            loadImages={loadImages}
            loadVideos={loadVideos}
            {...(contextOverride
              ? {
                  preferences: {
                    image: contextOverride.imageGenerationPreference ?? {
                      mode: "auto",
                      models: [],
                    },
                    video: contextOverride.videoGenerationPreference ?? {
                      mode: "auto",
                      models: [],
                    },
                  },
                  onPreferencesChange: (next: {
                    image: MediaModelPreference;
                    video: MediaModelPreference;
                  }) =>
                    onChangeContext({
                      ...contextOverride,
                      imageGenerationPreference: next.image,
                      videoGenerationPreference: next.video,
                    }),
                }
              : {})}
          />
        </>
      ) : null}
    </div>
  );
}
