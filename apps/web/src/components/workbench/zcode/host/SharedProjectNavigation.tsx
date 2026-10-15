import type { CodeUiWorkspace } from "@kenfutwork/shared";
import {
  type HostWorkbenchNavigation,
  parseLocalWorkspaceIdentity,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { useTabStoreApi } from "@zui/store/TabStoreProvider.js";
import {
  isWorkspaceTab,
  type TabStore,
  type WorkspaceTabState,
} from "@zui/store/tabStore.js";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { requestCanvasDocumentOpen } from "./conversationWorkContext.js";
import type { CodeHttpChannelClient } from "./httpChannelClient.js";
import { surfaceJson, surfaceRequest } from "./surfaceApi.js";

type Preset = "code" | "design";
type TaskFilter = "all" | Preset;
type ProjectHost = Pick<
  CodeHttpChannelClient,
  | "workspaces"
  | "projectForPath"
  | "openWorkspace"
  | "refreshWorkspaces"
  | "currentWorkPreset"
>;
interface ShareRequest {
  project: CodeUiWorkspace;
  preset: Preset;
  promise: Promise<boolean>;
  resolve: (shared: boolean) => void;
}
interface NavigationContext {
  projects: CodeUiWorkspace[];
  taskFilter: TaskFilter;
  setTaskFilter: (filter: TaskFilter) => void;
  openProject: (project: CodeUiWorkspace, preset: Preset) => Promise<boolean>;
  createProject: (preset: Preset) => Promise<void>;
  registerTabs: (tabs: TabStore | null) => void;
  error: string | null;
  retryDocument: (() => void) | null;
}
const Context = createContext<NavigationContext | null>(null);
let modeAdmission: ((preset: Preset) => Promise<boolean>) | null = null;
const pendingAdmissions = new Set<{
  preset: Preset;
  resolve: (allowed: boolean) => void;
}>();
export function admitProjectMode(preset: Preset): Promise<boolean> {
  if (modeAdmission) return modeAdmission(preset);
  return new Promise((resolve) => pendingAdmissions.add({ preset, resolve }));
}
export function projectSupportsMode(project: CodeUiWorkspace, preset: Preset) {
  return (project.enabledModes ?? [project.kind ?? "code"]).includes(preset);
}
export function filterProjectTabs(
  tabs: WorkspaceTabState[],
  projects: CodeUiWorkspace[],
  preset: Preset,
) {
  const byId = new Map(projects.map((project) => [project.projectId, project]));
  return tabs.flatMap((tab) => {
    const id = parseLocalWorkspaceIdentity(
      tab.workspaceIdentity ?? "",
      tab.workspacePath,
    )?.projectId;
    const project = id ? byId.get(id) : undefined;
    if (!project) return [tab];
    return projectSupportsMode(project, preset)
      ? [{ ...tab, label: project.name }]
      : [];
  });
}
export function taskMatchesWorkMode(task: ZCodeTaskMeta, filter: TaskFilter) {
  return filter === "all" || (task.workModes ?? ["code"]).includes(filter);
}

function activeProject(client: ProjectHost, tabs: TabStore | null) {
  const state = tabs?.getState();
  const tab = state?.tabs.find((item) => item.id === state.activeTabId);
  return tab && isWorkspaceTab(tab)
    ? client.projectForPath(tab.workspacePath, tab.workspaceIdentity)
    : null;
}

/** 初始父导航等真实 tab store；恢复出的项目也须符合当前已确认方式。 */
function useProjectModeAdmission(
  client: ProjectHost,
  tabs: TabStore | null,
  navigation: HostWorkbenchNavigation | undefined,
  askShare: (project: CodeUiWorkspace, preset: Preset) => Promise<boolean>,
  transition: { current: boolean },
) {
  useEffect(() => {
    if (!tabs) return;
    const admit = async (preset: Preset) => {
      const project = activeProject(client, tabs);
      return !project || askShare(project, preset);
    };
    modeAdmission = admit;
    for (const pending of pendingAdmissions) {
      pendingAdmissions.delete(pending);
      void admit(pending.preset).then(pending.resolve, () =>
        pending.resolve(false),
      );
    }
    let current = true;
    let checked = "";
    const checkRestore = () => {
      if (transition.current) return;
      const project = activeProject(client, tabs);
      const mode = navigation?.getSnapshot().mode;
      if (!project || !mode || mode === "flow") return;
      const key = JSON.stringify([
        project.projectId,
        mode,
        project.enabledModes,
      ]);
      if (key === checked) return;
      checked = key;
      if (projectSupportsMode(project, mode)) return;
      const fallback = project.kind === "design" ? "design" : "code";
      navigation?.setActiveMode(fallback);
      void askShare(project, mode).then((allowed) => {
        if (
          current &&
          allowed &&
          activeProject(client, tabs)?.projectId === project.projectId &&
          navigation?.getSnapshot().mode === fallback
        )
          navigation.open(mode);
      });
    };
    const releaseTabs = tabs.subscribe(checkRestore);
    const releaseProjects = client.workspaces.subscribe(checkRestore);
    const releaseNavigation = navigation?.subscribe(checkRestore);
    checkRestore();
    return () => {
      current = false;
      releaseTabs();
      releaseProjects();
      releaseNavigation?.();
      if (modeAdmission === admit) modeAdmission = null;
    };
  }, [askShare, client, navigation, tabs, transition]);
}

type OpenProject = (
  project: CodeUiWorkspace,
  preset: Preset,
  isCurrent?: () => boolean,
) => Promise<boolean>;
function useDocumentIntentNavigation(
  client: ProjectHost,
  tabs: TabStore | null,
  navigation: HostWorkbenchNavigation | undefined,
  openProject: OpenProject,
  setError: (error: string | null) => void,
) {
  const generation = useRef(0);
  const attempted =
    useRef<
      ReturnType<HostWorkbenchNavigation["getSnapshot"]>["documentTarget"]
    >(undefined);
  const [canRetry, setCanRetry] = useState(false);
  const open = useCallback(async () => {
    const target = navigation?.getSnapshot().documentTarget;
    if (!target || !tabs || attempted.current === target) return;
    attempted.current = target;
    const request = ++generation.current;
    const isCurrent = () =>
      request === generation.current &&
      navigation?.getSnapshot().documentTarget === target;
    setCanRetry(false);
    setError(null);
    try {
      const { canvas } = await surfaceJson<{
        canvas: { id: string; projectId: string; name: string };
      }>(`/api/canvases/${encodeURIComponent(target.documentId)}`);
      if (!isCurrent()) return;
      const project = (await client.refreshWorkspaces()).find(
        (item) => item.projectId === canvas.projectId,
      );
      if (!isCurrent()) return;
      if (!project) throw new Error("画布所属项目不可用，请重新选择项目。");
      if (!(await openProject(project, "design", isCurrent))) {
        if (isCurrent()) setCanRetry(true);
        return;
      }
      if (!isCurrent()) return;
      requestCanvasDocumentOpen({
        projectId: canvas.projectId,
        documentId: canvas.id,
        title: canvas.name,
      });
      navigation?.open("design");
    } catch (failure) {
      if (!isCurrent()) return;
      setError(
        failure instanceof Error ? failure.message : "画布不可用，请重新打开。",
      );
      setCanRetry(true);
    }
  }, [client, navigation, openProject, setError, tabs]);
  useEffect(() => {
    const release = navigation?.subscribe(() => {
      void open();
    });
    void open();
    return () => {
      release?.();
      generation.current++;
      attempted.current = undefined;
    };
  }, [navigation, open]);
  return canRetry
    ? () => {
        attempted.current = undefined;
        void open();
      }
    : null;
}

export function SharedProjectNavigationProvider({
  client,
  children,
  navigation,
}: {
  client: ProjectHost;
  children: ReactNode;
  navigation?: HostWorkbenchNavigation;
}) {
  const [projects, setProjects] = useState(() =>
    client.workspaces.projectCatalog(),
  );
  const tabsRef = useRef<TabStore | null>(null);
  const projectTransition = useRef(false);
  const [tabs, setTabs] = useState<TabStore | null>(null);
  const registerTabs = useCallback((store: TabStore | null) => {
    tabsRef.current = store;
    setTabs(() => store);
  }, []);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [request, setRequest] = useState<ShareRequest | null>(null);
  const requestRef = useRef<ShareRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const askShare = useCallback(
    (project: CodeUiWorkspace, preset: Preset) => {
      const latest =
        client.workspaces
          .projectCatalog()
          .find((item) => item.projectId === project.projectId) ?? project;
      if (projectSupportsMode(latest, preset)) return Promise.resolve(true);
      if (
        requestRef.current?.project.projectId === project.projectId &&
        requestRef.current.preset === preset
      )
        return requestRef.current.promise;
      requestRef.current?.resolve(false);
      let finish!: (shared: boolean) => void;
      const promise = new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      requestRef.current = {
        project: latest,
        preset,
        promise,
        resolve: finish,
      };
      setRequest(requestRef.current);
      return promise;
    },
    [client],
  );
  useEffect(() => {
    const release = client.workspaces.subscribe(() =>
      setProjects(client.workspaces.projectCatalog()),
    );
    return () => {
      release();
    };
  }, [client]);
  useProjectModeAdmission(
    client,
    tabs,
    navigation,
    askShare,
    projectTransition,
  );
  useEffect(
    () => () => {
      requestRef.current?.resolve(false);
      requestRef.current = null;
      for (const pending of pendingAdmissions) pending.resolve(false);
      pendingAdmissions.clear();
    },
    [],
  );
  const finish = (shared: boolean) => {
    requestRef.current?.resolve(shared);
    requestRef.current = null;
    setRequest(null);
  };
  const openProject = useCallback<OpenProject>(
    async (project, preset, isCurrent = () => true) => {
      if (!isCurrent() || !(await askShare(project, preset)) || !isCurrent())
        return false;
      const workspace = await client.openWorkspace(
        project.path,
        project.projectId,
        preset,
        isCurrent,
      );
      if (!isCurrent()) return false;
      const identity = client.workspaces.identityFor(
        workspace.projectId,
        workspace.path,
      );
      if (!tabsRef.current)
        throw new Error("项目导航不可用，请重新打开工作台。");
      projectTransition.current = true;
      try {
        tabsRef.current.getState().addTab(workspace.path, {
          ...(identity ? { workspaceIdentity: identity } : {}),
        });
        navigation?.setActiveMode(preset);
      } finally {
        projectTransition.current = false;
      }
      return true;
    },
    [askShare, client, navigation],
  );
  const retryDocument = useDocumentIntentNavigation(
    client,
    tabs,
    navigation,
    openProject,
    setError,
  );
  const createProject = async (preset: Preset) => {
    const result = await surfaceJson<{ project: { id: string } }>(
      "/api/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "未命名项目", kind: preset }),
      },
    );
    const project = (await client.refreshWorkspaces()).find(
      (item) => item.projectId === result.project.id,
    );
    if (!project) throw new Error("项目未加载，请重新打开工作台。");
    await openProject(project, preset);
  };
  useEffect(() => {
    const created = () => {
      void createProject(client.currentWorkPreset()).catch((failure) =>
        setError(
          failure instanceof Error ? failure.message : "创建项目失败，请重试。",
        ),
      );
    };
    const focused = () => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="chat-input"] [contenteditable="true"]',
        )
        ?.focus();
    };
    const deleted = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId: string }>).detail
        ?.projectId;
      const store = tabsRef.current;
      if (!projectId || !store) return;
      for (const tab of store.getState().tabs) {
        if (
          isWorkspaceTab(tab) &&
          parseLocalWorkspaceIdentity(
            tab.workspaceIdentity ?? "",
            tab.workspacePath,
          )?.projectId === projectId
        )
          store.getState().closeTab(tab.id);
      }
      void client
        .refreshWorkspaces()
        .catch((failure) =>
          setError(
            failure instanceof Error
              ? failure.message
              : "项目列表加载失败，请重试。",
          ),
        );
    };
    window.addEventListener("kenfutwork:new-project", created);
    window.addEventListener("kenfutwork:focus-session", focused);
    window.addEventListener("kenfutwork:project-deleted", deleted);
    return () => {
      window.removeEventListener("kenfutwork:new-project", created);
      window.removeEventListener("kenfutwork:focus-session", focused);
      window.removeEventListener("kenfutwork:project-deleted", deleted);
    };
  }, [client]);
  const share = async () => {
    const current = requestRef.current;
    if (!current) return;
    try {
      await surfaceRequest(
        `/api/projects/${encodeURIComponent(current.project.projectId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled_modes: [
              ...(current.project.enabledModes ?? [
                current.project.kind ?? "code",
              ]),
              current.preset,
            ],
          }),
        },
      );
      await client.refreshWorkspaces();
      if (current === requestRef.current) {
        setError(null);
        finish(true);
      }
    } catch (failure) {
      if (current === requestRef.current)
        setError(
          failure instanceof Error ? failure.message : "无法共享项目，请重试。",
        );
    }
  };
  return (
    <Context.Provider
      value={{
        projects,
        taskFilter,
        setTaskFilter,
        openProject,
        createProject,
        registerTabs,
        error,
        retryDocument,
      }}
    >
      {children}
      <Dialog
        open={Boolean(request)}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>共享项目</DialogTitle>
          </DialogHeader>
          <p>{request?.project.name}</p>
          <Button onClick={() => void share()}>
            启用 {request?.preset === "design" ? "Design" : "Code"}
          </Button>
          <Button variant="ghost" onClick={() => finish(false)}>
            取消
          </Button>
          {error ? <p role="alert">{error}</p> : null}
        </DialogContent>
      </Dialog>
    </Context.Provider>
  );
}

export function useSharedProjectTabs(tabs: WorkspaceTabState[]) {
  const context = useContext(Context);
  const store = useTabStoreApi();
  const registerTabs = context?.registerTabs;
  useEffect(() => {
    registerTabs?.(store);
    return () => registerTabs?.(null);
  }, [registerTabs, store]);
  const navigation = useOptionalPlatform()?.workbenchNavigation;
  const mode = useSyncExternalStore(
    navigation?.subscribe ?? (() => () => {}),
    () => navigation?.getSnapshot().mode ?? "code",
  );
  return useMemo(
    () =>
      context
        ? filterProjectTabs(
            tabs,
            context.projects,
            mode === "design" ? "design" : "code",
          )
        : tabs,
    [context, mode, tabs],
  );
}
export function useSharedTaskFilter() {
  return useContext(Context)?.taskFilter ?? "all";
}
export function SharedProjectNavigation() {
  const context = useContext(Context);
  const navigation = useOptionalPlatform()?.workbenchNavigation;
  const mode = useSyncExternalStore(
    navigation?.subscribe ?? (() => () => {}),
    () => navigation?.getSnapshot().mode ?? "code",
  );
  const [error, setError] = useState<string | null>(null);
  if (!context || mode === "flow") return null;
  const preset = mode === "design" ? "design" : "code";
  const act = (action: Promise<unknown>) => {
    setError(null);
    void action.catch((failure) =>
      setError(
        failure instanceof Error ? failure.message : "项目不可用，请重试。",
      ),
    );
  };
  return (
    <div className="flex flex-col gap-1 px-3 py-1 text-xs">
      <div className="flex gap-2">
        <select
          aria-label="打开项目"
          value=""
          className="min-w-0 flex-1 bg-transparent"
          onChange={(event) => {
            const project = context.projects.find(
              (item) => item.projectId === event.target.value,
            );
            if (project) act(context.openProject(project, preset));
          }}
        >
          <option value="">打开项目</option>
          {context.projects.map((project) => (
            <option key={project.projectId} value={project.projectId}>
              {project.name}
              {projectSupportsMode(project, preset) ? "" : " · 共享"}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="新建项目"
          onClick={() => act(context.createProject(preset))}
        >
          +
        </button>
      </div>
      <select
        aria-label="会话工作方式"
        value={context.taskFilter}
        className="bg-transparent"
        onChange={(event) =>
          context.setTaskFilter(event.target.value as TaskFilter)
        }
      >
        <option value="all">全部会话</option>
        <option value="code">Code</option>
        <option value="design">Design</option>
      </select>
      {error || context.error ? (
        <p role="alert">{error ?? context.error}</p>
      ) : null}
      {context.retryDocument ? (
        <button type="button" onClick={context.retryDocument}>
          重试画布
        </button>
      ) : null}
    </div>
  );
}
