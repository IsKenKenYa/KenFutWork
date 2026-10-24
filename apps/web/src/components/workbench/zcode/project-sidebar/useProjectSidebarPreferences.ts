import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectSidebarView, VirtualProject } from "@zui/project-sidebar/contract.js";
import { projectKey } from "@zui/project-sidebar/view.js";
import { getSafeLocalStorage } from "@zui/lib/browserEnvironment.js";
import { readWorkspaceExpansionState } from "@zui/lib/workspaceExpansionPreference.js";
import { reconcileProjectOrder, moveProjectOrder } from "@zui/project-sidebar/projectOrder.js";
import { readProjectSidebarView } from "@zui/project-sidebar/view-preference.js";

const KEY = "zcode-project-sidebar-preferences";
interface Preferences {
  order: string[];
  view: ProjectSidebarView;
  expanded: Record<string, boolean>;
}
function read(key: string): Record<string, unknown> {
  try {
    return JSON.parse(getSafeLocalStorage()?.getItem(key) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function write(key: string, value: unknown) {
  try {
    getSafeLocalStorage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* 浏览器禁用存储时仍保持当前窗口选择，不影响 Host 命令。 */
  }
}
export function useProjectSidebarPreferences(projects: VirtualProject[], loading: boolean) {
  const [legacyExpansion] = useState(readWorkspaceExpansionState);
  const [preferences, setPreferences] = useState<Preferences>(() => {
    const saved = read(KEY);
    return {
      order: reconcileProjectOrder(
        Array.isArray(saved.order) ? saved.order.filter((key): key is string => typeof key === "string") : [],
        loading ? [] : projects.map(projectKey),
      ),
      view: readProjectSidebarView(),
      expanded: saved.expanded && typeof saved.expanded === "object"
        ? Object.fromEntries(Object.entries(saved.expanded).filter(([, value]) => typeof value === "boolean"))
        : {},
    };
  });
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.key !== KEY || !event.newValue) return;
      try {
        const value = JSON.parse(event.newValue) as Partial<Preferences>;
        if (!Array.isArray(value.order) || !value.order.every((key) => typeof key === "string")) return;
        setPreferences((previous) => ({
          ...previous,
          order: [...new Set(value.order)],
          view: value.view === "timeline" || value.view === "grouped" ? value.view : "projects",
          expanded: value.expanded && typeof value.expanded === "object"
            ? Object.fromEntries(Object.entries(value.expanded).filter(([, expanded]) => typeof expanded === "boolean"))
            : previous.expanded,
        }));
      } catch {
        /* 损坏的显示设置不影响当前项目目录。 */
      }
    };
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, []);
  const currentKeys = JSON.stringify(projects.map(projectKey));
  useEffect(() => {
    if (loading) return;
    setPreferences((previous) => {
      const order = reconcileProjectOrder(previous.order, JSON.parse(currentKeys) as string[]);
      if (order.length === previous.order.length && order.every((key, index) => key === previous.order[index])) return previous;
      const next = { ...previous, order };
      write(KEY, next);
      return next;
    });
  }, [currentKeys, loading]);
  const changeOrder = useCallback((change: (order: string[]) => string[]) => {
    setPreferences((previous) => {
      const next = { ...previous, order: change(reconcileProjectOrder(previous.order, [])) };
      write(KEY, next);
      return next;
    });
  }, []);
  const update = useCallback((patch: Partial<Preferences>) => setPreferences((previous) => {
    const next = { ...previous, ...patch };
    write(KEY, next);
    return next;
  }), []);
  const setView = useCallback((view: ProjectSidebarView) => update({ view }), [update]);
  return useMemo(() => ({
    order: preferences.order,
    prepend: (project: VirtualProject) => changeOrder((order) => [projectKey(project), ...order.filter((key) => key !== projectKey(project))]),
    sort: (items: VirtualProject[]) => {
      const order = reconcileProjectOrder(preferences.order, items.map(projectKey));
      const positions = new Map(order.map((key, index) => [key, index]));
      return [...items].sort((a, b) => positions.get(projectKey(a))! - positions.get(projectKey(b))!);
    },
    reorder: (section: VirtualProject[], active: string, over: string) => changeOrder((order) => moveProjectOrder(order, section.map(projectKey), active, over)),
    view: preferences.view,
    setView,
    isExpanded: (project: VirtualProject) => preferences.expanded[projectKey(project)] ?? (project.roots.length === 1 ? legacyExpansion[project.roots[0]!.rootPath] !== false : true),
    setAllExpanded: (items: VirtualProject[], expanded: boolean) => setPreferences((previous) => {
      const next = { ...previous, expanded: { ...previous.expanded, ...Object.fromEntries(items.map((project) => [projectKey(project), expanded])) } };
      write(KEY, next);
      return next;
    }),
    setExpanded: (project: VirtualProject, expanded: boolean) => setPreferences((previous) => {
      const next = { ...previous, expanded: { ...previous.expanded, [projectKey(project)]: expanded } };
      write(KEY, next);
      return next;
    }),
  }), [preferences, changeOrder, setView, legacyExpansion]);
}
