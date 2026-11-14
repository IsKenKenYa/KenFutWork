import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectTree } from "@zui/project-sidebar/contract.js";
import { useBaseWorkspaceServices } from "@zui/hooks/useWorkspaceServices.js";
import { getWindowControllerTaskListRegistry } from "@zui/v4/windowControllerTaskListRegistry.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { logger } from "@zui/logger.js";
import { canonicalLocalWorkspaceIdentity, parseLocalWorkspaceIdentity } from "@zcode/shared";
import { useOptionalTabStore } from "@zui/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@zui/store/tabStore.js";
import { applyProjectTaskActivities, stabilizeProjectTree } from "@zui/project-sidebar/view.js";

const EMPTY: ProjectTree = { projects: [], tasks: [] };

function projectDirectoryScopes(
  tree: ProjectTree,
  tabScopes: readonly { workspacePath: string; workspaceIdentity: string }[],
) {
  const entries = new Map<string, { workspacePath: string; workspaceIdentity: string }>();
  for (const task of tree.tasks) {
    const identity = task.workspaceIdentity;
    if (identity)
      entries.set(identity, { workspacePath: task.workspacePath, workspaceIdentity: identity });
  }
  for (const project of tree.projects) {
    const root = project.roots.find((entry) => entry.isPrimary);
    if (project.deleted || !root) continue;
    const identity = canonicalLocalWorkspaceIdentity(project.id, root.rootPath);
    entries.set(identity, { workspacePath: root.rootPath, workspaceIdentity: identity });
  }
  for (const scope of tabScopes) entries.set(scope.workspaceIdentity, scope);
  return [...entries.values()].sort((a, b) => a.workspaceIdentity.localeCompare(b.workspaceIdentity));
}

export function useProjectTree() {
  const services = useBaseWorkspaceServices();
  const service = services.projectService;
  const controller = services.windowControllerService;
  const registry = useMemo(
    () => controller ? getWindowControllerTaskListRegistry(controller) : null,
    [controller],
  );
  const tabs = useOptionalTabStore((state) => state.tabs);
  const tabScopes = useMemo(() => tabs.flatMap((tab) => {
    if (!isWorkspaceTab(tab)) return [];
    const identity = parseLocalWorkspaceIdentity(tab.workspaceIdentity, tab.workspacePath);
    return identity ? [{
      workspacePath: tab.workspacePath,
      workspaceIdentity: canonicalLocalWorkspaceIdentity(identity.projectId, tab.workspacePath),
    }] : [];
  }).sort((a, b) => a.workspaceIdentity.localeCompare(b.workspaceIdentity)), [tabs]);
  const tabScopeKey = JSON.stringify(tabScopes);
  const version = useZCodeSessionStore((state) =>
    Object.values(state.workspaces).reduce((n, workspace) => n + workspace.taskListVersion, 0),
  );
  const [tree, setTree] = useState<ProjectTree>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const serial = useRef(0);
  const reads = useMemo(
    () => ({ flight: null as Promise<void> | null, dirty: false }),
    [service, registry, tabScopeKey],
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
      const scopes = projectDirectoryScopes(next, tabScopes);
      const activity = registry && scopes.length
        ? await registry.list(
            "project-directory",
            {
              controllerRevision: registry.getRevision(),
              taskListVersionSignature: JSON.stringify(scopes),
            },
            { kind: "timeline", workspaceScopes: scopes, sortBy: "updated" },
          )
        : null;
      if (request === serial.current) {
        const displayed = activity ? applyProjectTaskActivities(next, activity.items) : next;
        setTree((previous) => stabilizeProjectTree(previous, displayed));
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
  }, [service, registry, tabScopeKey]);
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
  }, [refresh, version, tabScopeKey]);
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
  useEffect(() => {
    return registry?.subscribe(() => void refresh());
  }, [registry, refresh]);
  return useMemo(
    () => ({ tree, refresh, error, loading }),
    [tree, refresh, error, loading],
  );
}
