import { useEffect, useRef } from "react";
import { surfaceJson } from "./surfaceApi.js";

/** 对话侧新建 OpenDesign 项目后，宿主广播给已挂载画布的事件。 */
export const OPEN_DESIGN_PROJECT_EVENT = "kenfutwork:open-design-project";

/** 项目槽位来自本地文件，没有推送通道；轮询间隔只需跟手，不必实时。 */
const POLL_INTERVAL_MS = 4_000;

interface LastProjectResponse {
  project?: { projectId?: string; name?: string };
}

/**
 * 盯住「最近创建的 OpenDesign 项目」：一旦 agent 通过工具新建项目，
 * 打开右侧画布并广播项目变更；启动时的旧项目只记录、不抢焦点。
 */
export function useOpenDesignProjectWatch(
  enabled: boolean,
  onProjectCreated?: (projectId: string) => void,
) {
  const created = useRef(onProjectCreated);
  created.current = onProjectCreated;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let seen: string | null | undefined;
    let primed = false;

    const tick = async () => {
      try {
        const data = await surfaceJson<LastProjectResponse>(
          "/api/open-design/last-project",
        );
        if (cancelled) return;
        const projectId = data?.project?.projectId ?? null;
        if (!primed) {
          primed = true;
          seen = projectId;
          return;
        }
        if (!projectId) {
          seen = null;
          return;
        }
        if (projectId === seen) return;
        seen = projectId;
        window.dispatchEvent(
          new CustomEvent(OPEN_DESIGN_PROJECT_EVENT, {
            detail: { projectId, name: data?.project?.name ?? null },
          }),
        );
        created.current?.(projectId);
      } catch {
        // 探针失败不打断画布，下一轮再试。
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);
}
