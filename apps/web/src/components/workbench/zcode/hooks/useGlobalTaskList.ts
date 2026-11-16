import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  WindowHostControllerTaskListItem,
  ZCodeTaskListKind,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import { logger } from "@zui/logger.js";
import { useBaseWorkspaceServices } from "@zui/hooks/useWorkspaceServices.js";
import type { WorkspaceTabState } from "@zui/store/tabStore.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { attachTaskListRowActivity } from "@zui/v4/taskListRowActivity.js";
import { stabilizeTaskListItems } from "@zui/v4/taskListItemStabilization.js";
import { getWindowControllerTaskListRegistry } from "@zui/v4/windowControllerTaskListRegistry.js";
import type { WindowControllerTaskListVersion } from "@zui/v4/windowControllerTaskListRegistry.js";

type GlobalTaskListItem = WindowHostControllerTaskListItem;

type TaskListRead = {
  items: GlobalTaskListItem[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: { cause: unknown } | null;
};

const emptyRead: TaskListRead = {
  items: [],
  total: 0,
  hasMore: false,
  loading: false,
  error: null,
};
const pendingRead: TaskListRead = { ...emptyRead, loading: true };
const subscribeToNothing = () => () => {};
const zeroRevision = () => 0;

function buildWorkspaceScopes(workspaceTabs: WorkspaceTabState[]): ZCodeTaskListWorkspaceScope[] {
  const scopes = new Map<string, ZCodeTaskListWorkspaceScope>();
  for (const tab of workspaceTabs) {
    const scope = {
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    };
    scopes.set(
      JSON.stringify([tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath]),
      scope,
    );
  }
  return Array.from(scopes.values());
}

export function useGlobalTaskList(params: {
  kind: ZCodeTaskListKind;
  workspaceTabs: WorkspaceTabState[];
  sortBy: "created" | "updated";
  searchQuery: string;
  expanded: boolean;
  collapsedLimit: number;
}) {
  const baseServices = useBaseWorkspaceServices();
  const controller = baseServices.windowControllerService;
  const controllerRegistry = useMemo(
    () => (controller ? getWindowControllerTaskListRegistry(controller) : null),
    [controller],
  );
  const controllerRevision = useSyncExternalStore(
    controllerRegistry?.subscribe ?? subscribeToNothing,
    controllerRegistry?.getRevision ?? zeroRevision,
    controllerRegistry?.getRevision ?? zeroRevision,
  );
  const workspaceSignature = JSON.stringify(
    params.workspaceTabs
      .map(
        (tab) => [tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath] as const,
      )
      .sort(
        ([leftKey, leftPath], [rightKey, rightPath]) =>
          leftKey.localeCompare(rightKey) || leftPath.localeCompare(rightPath),
      ),
  );
  const workspaceSourceGenerationSignature = JSON.stringify(
    params.workspaceTabs
      .map(
        (tab) =>
          [
            tab.workspaceIdentity?.trim() || tab.workspacePath,
            tab.workspacePath,
            tab.remoteSessionId?.trim() || null,
          ] as const,
      )
      .sort(
        ([leftKey, leftPath, leftSession], [rightKey, rightPath, rightSession]) =>
          leftKey.localeCompare(rightKey) ||
          leftPath.localeCompare(rightPath) ||
          (leftSession ?? "").localeCompare(rightSession ?? ""),
      ),
  );
  const workspaceScopes = useMemo(
    () => buildWorkspaceScopes(params.workspaceTabs),
    // workspaceSignature 是标准化后的 scope 值签名，避免父组件重建 tabs 数组时重复查询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceSignature],
  );
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    JSON.stringify(
      params.workspaceTabs
        .map((tab) => {
          const workspace = selectWorkspaceZCodeState(
            state,
            tab.workspacePath,
            tab.workspaceIdentity,
          );
          return [
            tab.workspaceIdentity?.trim() || tab.workspacePath,
            workspace.taskListVersion,
          ] as const;
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  const requestSerialRef = useRef(0);
  const manualRefreshSerialRef = useRef(0);

  const search = params.searchQuery.trim();
  const query = useMemo(
    () => ({
      kind: params.kind,
      workspaceScopes,
      sortBy: params.sortBy,
      search: search || undefined,
      limit: params.expanded ? undefined : params.collapsedLimit,
    }),
    [
      params.collapsedLimit,
      params.expanded,
      params.kind,
      params.sortBy,
      search,
      workspaceScopes,
    ],
  );
  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const readScope = useMemo(
    () => ({ queryKey, controllerRegistry, workspaceSourceGenerationSignature }),
    [queryKey, controllerRegistry, workspaceSourceGenerationSignature],
  );
  const [read, setRead] = useState<(TaskListRead & { scope: typeof readScope }) | null>(null);
  const currentRead =
    read?.scope === readScope ? read : workspaceScopes.length > 0 ? pendingRead : emptyRead;

  const load = useCallback(
    async (version: WindowControllerTaskListVersion) => {
      const requestSerial = ++requestSerialRef.current;
      if (query.workspaceScopes.length === 0) return;
      setRead((previous) => ({
        ...(previous?.scope === readScope ? previous : emptyRead),
        scope: readScope,
        loading: true,
        error: null,
      }));
      try {
        if (!controllerRegistry) throw new Error("window Host Controller channel unavailable");
        const result = await controllerRegistry.list(queryKey, version, query);
        if (requestSerialRef.current !== requestSerial) return;
        const items = result.items.map((item) =>
          item.activity ? attachTaskListRowActivity(item, item.activity) : item,
        );
        // 同一查询中复用未变化的行，避免运行更新触发列表重新测量。
        setRead((previous) => ({
          scope: readScope,
          items: stabilizeTaskListItems(previous?.scope === readScope ? previous.items : emptyRead.items, items),
          total: result.total,
          hasMore: result.hasMore,
          loading: false,
          error: null,
        }));
      } catch (cause) {
        if (requestSerialRef.current !== requestSerial) return;
        logger.error(`[useGlobalTaskList] Controller 加载 ${query.kind} 列表失败`, cause);
        setRead((previous) => ({
          ...(previous?.scope === readScope ? previous : emptyRead),
          scope: readScope,
          loading: false,
          error: { cause },
        }));
      }
    },
    [controllerRegistry, query, queryKey, readScope],
  );

  const refresh = useCallback(async () => {
    manualRefreshSerialRef.current += 1;
    await load({
      controllerRevision,
      taskListVersionSignature,
      workspaceSourceGenerationSignature,
      manualRefreshSerial: manualRefreshSerialRef.current,
    });
  }, [controllerRevision, load, taskListVersionSignature, workspaceSourceGenerationSignature]);

  useEffect(() => {
    // 远程 workspace 从断开占位恢复为在线 session 时 identity/path 不变，
    // taskListVersion 也可能尚未变化，旧缓存因此永久保留连接前的空结果。remoteSessionId
    // 只作为 source 代际触发重查，不改变 workspaceIdentity 与 Controller 查询契约。
    void load({
      controllerRevision,
      taskListVersionSignature,
      workspaceSourceGenerationSignature,
    });
    return () => { requestSerialRef.current += 1; };
  }, [controllerRevision, load, taskListVersionSignature, workspaceSourceGenerationSignature]);

  const hasRemoteScope = params.workspaceTabs.some((tab) => Boolean(tab.workspaceIdentity));
  return {
    items: currentRead.items,
    total: currentRead.total,
    hasMore: currentRead.hasMore,
    loading: currentRead.loading,
    error: currentRead.error,
    syncingRemoteWorkspaces: currentRead.loading && hasRemoteScope,
    refresh,
  };
}
