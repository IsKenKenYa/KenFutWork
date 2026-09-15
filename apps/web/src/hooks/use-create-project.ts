"use client";

import type {
  ImageGenerationPreference,
  VideoGenerationPreference,
} from "@loomic/shared";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { useToast } from "@/components/toast";
import type { ReadyAttachment } from "@/hooks/use-image-attachments";
import { useAuth } from "@/lib/auth-context";
import { ApiAuthError, createProject } from "@/lib/server-api";

/** sessionStorage key used to pass attachments from Home → Canvas auto-send. */
export const INITIAL_ATTACHMENTS_KEY = "loomic:initial-attachments";
export const INITIAL_IMAGE_GENERATION_PREFERENCE_KEY =
  "loomic:initial-image-generation-preference";
export const INITIAL_VIDEO_GENERATION_PREFERENCE_KEY =
  "loomic:initial-video-generation-preference";
export const INITIAL_AGENT_MODEL_KEY = "loomic:initial-agent-model";

/**
 * Shared hook for creating an Untitled project and navigating to its canvas.
 * Used by Home page, Projects page, and Canvas logo menu.
 */
export function useCreateProject() {
  const { session, signOut } = useAuth();
  const router = useRouter();
  const { error: toastError } = useToast();
  const [creating, setCreating] = useState(false);

  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;
  const routerRef = useRef(router);
  routerRef.current = router;

  const create = useCallback(
    async (opts?: {
      prompt?: string;
      attachments?: ReadyAttachment[];
      imageGenerationPreference?: ImageGenerationPreference;
      videoGenerationPreference?: VideoGenerationPreference;
      model?: string;
    }) => {
      const token = session?.access_token;
      if (!token || creating) return;

      // Persist attachments in sessionStorage BEFORE window.open so the
      // new tab's cloned sessionStorage already contains them.
      // (sessionStorage is per-tab; new tabs get a snapshot at open time.)
      if (opts?.attachments && opts.attachments.length > 0) {
        try {
          sessionStorage.setItem(
            INITIAL_ATTACHMENTS_KEY,
            JSON.stringify(opts.attachments),
          );
        } catch {
          // sessionStorage write failure is non-fatal
        }
      } else {
        sessionStorage.removeItem(INITIAL_ATTACHMENTS_KEY);
      }

      if (opts?.imageGenerationPreference) {
        try {
          sessionStorage.setItem(
            INITIAL_IMAGE_GENERATION_PREFERENCE_KEY,
            JSON.stringify(opts.imageGenerationPreference),
          );
        } catch {
          // sessionStorage write failure is non-fatal
        }
      } else {
        sessionStorage.removeItem(INITIAL_IMAGE_GENERATION_PREFERENCE_KEY);
      }

      if (opts?.videoGenerationPreference) {
        try {
          sessionStorage.setItem(
            INITIAL_VIDEO_GENERATION_PREFERENCE_KEY,
            JSON.stringify(opts.videoGenerationPreference),
          );
        } catch {
          // sessionStorage write failure is non-fatal
        }
      } else {
        sessionStorage.removeItem(INITIAL_VIDEO_GENERATION_PREFERENCE_KEY);
      }

      if (opts?.model) {
        try {
          sessionStorage.setItem(INITIAL_AGENT_MODEL_KEY, opts.model);
        } catch {
          // sessionStorage write failure is non-fatal
        }
      } else {
        sessionStorage.removeItem(INITIAL_AGENT_MODEL_KEY);
      }

      /**
       * 嵌在工作台 iframe 里时**不要**开新浏览器标签：用户点的是画布菜单里的「新建项目」，
       * 期望留在工作台里看新画布，而不是被弹到另一个浏览器标签（实测反馈「会跳走」）。
       * 这时改为把新画布 id 回传宿主，由宿主切换选中（见 workbench 的 message 处理）。
       * 独立打开画布页时保持原行为：同步开标签、拿到 URL 再赋值——同步开是为了不被弹窗拦截。
       */
      const embedded =
        typeof window !== "undefined" && window.parent !== window;
      const newTab = embedded
        ? null
        : window.open("/loading-preview", "_blank");

      setCreating(true);
      try {
        // 名称统一为「未命名画布」：侧栏/画布标题同口径（此前是 Untitled，与画布页的默认名不一致）
        const result = await createProject(token, { name: "未命名画布" });
        const canvasId = result.project.primaryCanvas.id;
        // 嵌入工作台 iframe：通知宿主刷新项目列表并切到新画布
        if (embedded) {
          window.parent.postMessage(
            {
              type: "workbench:project-created",
              projectId: result.project.id,
              canvasId,
            },
            window.location.origin,
          );
        }

        const url = opts?.prompt
          ? `/canvas?id=${canvasId}&prompt=${encodeURIComponent(opts.prompt)}`
          : `/canvas?id=${canvasId}`;

        if (embedded) {
          // 宿主负责切换（上面的 postMessage）；本页不跳转
        } else if (newTab) {
          newTab.location.href = url;
        } else {
          // Popup was blocked despite sync open — fallback to in-page navigation
          routerRef.current.push(url);
        }
        setCreating(false);
      } catch (err) {
        // Close the blank tab on failure
        newTab?.close();
        if (err instanceof ApiAuthError) {
          await signOutRef.current();
          routerRef.current.replace("/login");
          return;
        }
        toastError("项目创建失败");
        setCreating(false);
      }
    },
    [session?.access_token, creating, toastError],
  );

  return { create, creating };
}
