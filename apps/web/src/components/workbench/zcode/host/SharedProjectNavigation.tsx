import type { CodeUiWorkspace } from "@kenfutwork/shared";
import {
  type HostWorkbenchNavigation,
  parseLocalWorkspaceIdentity,
} from "@zcode/shared";
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
import { projectSupportsMode } from "./taskWorkspaceRegistry.js";

export { projectSupportsMode } from "./taskWorkspaceRegistry.js";

type Preset = "code" | "design";
type ProjectHost = Pick<
  CodeHttpChannelClient,
  | "workspaces"
  | "projectForPath"
  | "openWorkspace"
  | "refreshWorkspaces"
  | "currentWorkPreset"
  | "services"
>;
interface NavigationContext {
  projects: CodeUiWorkspace[];
  refreshProjects: () => Promise<void>;
  openProject: (project: CodeUiWorkspace, preset: Preset) => Promise<boolean>;
  createProject: (preset: Preset) => Promise<void>;
  creation: { creationId: string; kind: Preset } | null;
  closeProjectCreation: (creationId: string) => void;
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
function activeProject(client: ProjectHost, tabs: TabStore | null) {
  const state = tabs?.getState();
  const tab = state?.tabs.find((item) => item.id === state.activeTabId);
  return tab && isWorkspaceTab(tab)
    ? client.projectForPath(tab.workspacePath, tab.workspaceIdentity)
    : null;
}

/** 显式模式意图等待真实项目；被动恢复只回落到项目已启用的方式。 */
function useProjectModeAdmission(
  client: ProjectHost,
  tabs: TabStore | null,
  navigation: HostWorkbenchNavigation | undefined,
  askShare: (project: CodeUiWorkspace, preset: Preset) => Promise<boolean>,
  transition: { current: boolean },
) {
  useEffect(() => {
    if (!tabs) return;
    let unboundPreset: Preset | null = null;
    let checkedDocument: ReturnType<
      HostWorkbenchNavigation["getSnapshot"]
    >["documentTarget"];
    const admit = async (preset: Preset) => {
      const project = activeProject(client, tabs);
      unboundPreset = project ? null : preset;
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
      const snapshot = navigation?.getSnapshot();
      if (snapshot?.documentTarget !== checkedDocument) {
        checkedDocument = snapshot?.documentTarget;
        if (checkedDocument) unboundPreset = null;
      }
      const project = activeProject(client, tabs);
      const mode = snapshot?.mode;
      if (!project || !mode || mode === "flow") return;
      const explicitPreset = unboundPreset;
      unboundPreset = null;
      const target = explicitPreset ?? mode;
      const key = JSON.stringify([
        project.projectId,
        target,
        project.enabledModes,
      ]);
      if (!explicitPreset && key === checked) return;
      checked = key;
      if (projectSupportsMode(project, target)) {
        if (explicitPreset) navigation?.setActiveMode(explicitPreset);
        return;
      }
      const fallback = project.kind === "design" ? "design" : "code";
      navigation?.setActiveMode(fallback);
      if (!explicitPreset) return;
      void askShare(project, explicitPreset).then((allowed) => {
        if (
          current &&
          allowed &&
          activeProject(client, tabs)?.projectId === project.projectId &&
          navigation?.getSnapshot().mode === fallback
        )
          navigation.open(explicitPreset);
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
  const sharingRef = useRef(new Map<string, Promise<boolean>>());
  const [error, setError] = useState<string | null>(null);
  const [creation, setCreation] = useState<NavigationContext["creation"]>(null);
  const closeProjectCreation = useCallback((creationId: string) => {
    setCreation((current) =>
      current?.creationId === creationId ? null : current,
    );
  }, []);
  /** 切工作方式为该项目启用新档位：不弹确认框，失败才回落成侧栏错误提示。 */
  const askShare = useCallback(
    (project: CodeUiWorkspace, preset: Preset) => {
      const latest =
        client.workspaces
          .projectCatalog()
          .find((item) => item.projectId === project.projectId) ?? project;
      if (projectSupportsMode(latest, preset)) return Promise.resolve(true);
      const key = `${latest.projectId}:${preset}`;
      const inflight = sharingRef.current.get(key);
      if (inflight) return inflight;
      const request: Promise<boolean> = surfaceRequest(
        `/api/projects/${encodeURIComponent(latest.projectId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled_modes: [
              ...(latest.enabledModes ?? [latest.kind ?? "code"]),
              preset,
            ],
          }),
        },
      )
        .then(() => client.refreshWorkspaces())
        .then(() => {
          setError(null);
          return true;
        })
        .catch((failure: unknown) => {
          setError(
            failure instanceof Error
              ? failure.message
              : "无法为该项目启用这个工作方式，请重试。",
          );
          return false;
        })
        .finally(() => {
          sharingRef.current.delete(key);
        });
      sharingRef.current.set(key, request);
      return request;
    },
    [client],
  );
  useEffect(() => {
    const release = client.workspaces.subscribe(() => {
      const nextProjects = client.workspaces.projectCatalog();
      setProjects(nextProjects);
      const names = new Map(
        nextProjects.map((project) => [project.projectId, project.name]),
      );
      tabsRef.current?.setState((state) => {
        let changed = false;
        const nextTabs = state.tabs.map((tab) => {
          if (!isWorkspaceTab(tab)) return tab;
          const projectId = parseLocalWorkspaceIdentity(
            tab.workspaceIdentity ?? "",
            tab.workspacePath,
          )?.projectId;
          const name = projectId ? names.get(projectId) : undefined;
          if (!name || name === tab.label) return tab;
          changed = true;
          return { ...tab, label: name };
        });
        return changed ? { tabs: nextTabs } : state;
      });
    });
    return () => {
      release();
    };
  }, [client]);
  useEffect(() => {
    let active = true;
    const subscription = client.services.broadcastService.onMessage(
      ({ channel }) => {
        if (channel !== "state:projects") return;
        void client.refreshWorkspaces().catch((cause: unknown) => {
          if (active)
            setError(
              cause instanceof Error
                ? cause.message
                : "项目读取失败 请重新连接工作台",
            );
        });
      },
    );
    return () => {
      active = false;
      subscription.dispose();
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
      for (const pending of pendingAdmissions) pending.resolve(false);
      pendingAdmissions.clear();
    },
    [],
  );
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
  const refreshProjects = useCallback(async () => {
    await client.refreshWorkspaces();
  }, [client]);
  const createProject = useCallback(async (preset: Preset) => {
    setCreation({ creationId: crypto.randomUUID(), kind: preset });
  }, []);
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
  }, [client, createProject]);
  return (
    <Context.Provider
      value={{
        projects,
        refreshProjects,
        openProject,
        createProject,
        creation,
        closeProjectCreation,
        registerTabs,
        error,
        retryDocument,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useSharedProjectRefresh() {
  return useContext(Context)?.refreshProjects ?? null;
}

/** 原项目菜单按稳定身份消费全量目录，工作方式仍取同一服务端投影。 */
export function useSharedProjectCatalog() {
  return useContext(Context)?.projects ?? null;
}

export function useSharedProjectCreation() {
  const context = useContext(Context);
  return context
    ? {
        creation: context.creation,
        createProject: context.createProject,
        closeProjectCreation: context.closeProjectCreation,
      }
    : null;
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
/** 侧栏顶部的项目故障面：打开/新建项目与工作方式筛选都不在这里（项目列表与 composer 的项目选择器承载）。 */
export function SharedProjectNavigation() {
  const context = useContext(Context);
  const navigation = useOptionalPlatform()?.workbenchNavigation;
  const mode = useSyncExternalStore(
    navigation?.subscribe ?? (() => () => {}),
    () => navigation?.getSnapshot().mode ?? "code",
  );
  if (!context || mode === "flow") return null;
  if (!context.error && !context.retryDocument) return null;
  return (
    <div className="flex flex-col gap-1 px-3 py-1 text-xs">
      {context.error ? <p role="alert">{context.error}</p> : null}
      {context.retryDocument ? (
        <button type="button" onClick={context.retryDocument}>
          重试画布
        </button>
      ) : null}
    </div>
  );
}
