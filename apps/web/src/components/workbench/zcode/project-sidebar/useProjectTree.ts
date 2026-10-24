import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectTree } from "@zui/project-sidebar/contract.js";
import { useBaseWorkspaceServices } from "@zui/hooks/useWorkspaceServices.js";
import { getWindowControllerTaskListRegistry } from "@zui/v4/windowControllerTaskListRegistry.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { logger } from "@zui/logger.js";

const EMPTY: ProjectTree = { projects: [], tasks: [] };

export function useProjectTree() {
  const services = useBaseWorkspaceServices();
  const service = services.projectService;
  const controller = services.windowControllerService;
  const version = useZCodeSessionStore((state) =>
    Object.values(state.workspaces).reduce((n, workspace) => n + workspace.taskListVersion, 0),
  );
  const [tree, setTree] = useState<ProjectTree>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const serial = useRef(0);
  const reads = useMemo(
    () => ({ flight: null as Promise<void> | null, dirty: false }),
    [service],
  );
  const readOnce = useCallback(async () => {
    const request = serial.current;
    try {
      if (!service) throw new Error("project.service-unavailable");
      const next = await service.readTree({
        hostId: "local",
        includeDeleted: true,
        includeDeletedTasks: true,
      });
      if (request === serial.current) {
        setTree(next);
        setError(null);
      }
    } catch (cause) {
      if (request === serial.current) {
        setError(String(cause));
        logger.error("[project-sidebar] 读取项目树失败", cause);
      }
    } finally {
      if (request === serial.current) setLoading(false);
    }
  }, [service]);
  const refresh = useCallback(() => {
    reads.dirty = true;
    if (reads.flight) return reads.flight;
    const generation = serial.current;
    const flight = (async () => {
      while (reads.dirty && generation === serial.current) {
        reads.dirty = false;
        await readOnce();
      }
    })().finally(() => {
      if (reads.flight === flight) reads.flight = null;
    });
    reads.flight = flight;
    return flight;
  }, [readOnce, reads]);
  useEffect(
    () => () => {
      serial.current++;
      reads.flight = null;
    },
    [reads],
  );
  useEffect(() => {
    void refresh();
  }, [refresh, version]);
  useEffect(() => {
    const subscription = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") void refresh();
    });
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      subscription.dispose();
      window.removeEventListener("focus", onFocus);
    };
  }, [services.broadcastService, refresh]);
  const scopes = useMemo(() => {
    const entries = new Map<string, { workspacePath: string; workspaceIdentity: string }>();
    for (const task of tree.tasks) {
      const identity = task.workspaceIdentity;
      if (identity)
        entries.set(identity, { workspacePath: task.workspacePath, workspaceIdentity: identity });
    }
    return [...entries.values()].sort((a, b) => a.workspaceIdentity.localeCompare(b.workspaceIdentity));
  }, [tree.tasks]);
  const scopeKey = JSON.stringify(scopes);
  useEffect(() => {
    if (!controller) return;
    const registry = getWindowControllerTaskListRegistry(controller);
    const release = registry.subscribe(() => void refresh());
    if (scopes.length) void registry.list(
      "project-directory",
      { controllerRevision: registry.getRevision(), taskListVersionSignature: scopeKey },
      { kind: "timeline", workspaceScopes: scopes, sortBy: "updated", limit: 0 },
    ).catch((cause) => logger.error("[project-sidebar] 目录活动订阅失败", cause));
    return release;
  }, [controller, scopeKey, refresh]);
  return useMemo(
    () => ({ tree, refresh, error, loading }),
    [tree, refresh, error, loading],
  );
}
