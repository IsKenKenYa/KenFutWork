import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Blocks, Cable, Folder, Hash, MessageCirclePlus, Palette, PanelLeftClose, Search, WandSparkles } from "lucide-react";
import { parseLocalWorkspaceIdentity, TID_SIDEBAR } from "@zcode/shared";
import { SidebarTooltipProvider } from "@zui/ControlHintTooltip.js";
import { cn } from "@zui/components/lib/utils.js";
import { ScrollFadeViewport } from "@zui/components/ui/scroll-fade-viewport.js";
import { Tabs, TabsList, TabsTrigger } from "@zui/components/ui/tabs.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { setPendingSettingsSectionIntent } from "@zui/lib/settingsNavigation.js";
import { useZCodeStore } from "@zui/store/StoreProvider.js";
import { useTabStore } from "@zui/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@zui/store/tabStore.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { WorkspaceSidebarFooter } from "@zui/WorkspaceSidebarFooter.js";
import { HostModeSidebarContent } from "@zui/host/ModeSidebarContent.js";
import { PluginSidebarNavigation } from "@zui/host/PluginSidebarNavigation.js";
import { prepareProjectCreation, ProjectEditorAdapter } from "@zui/host/ProjectEditorAdapter.js";
import { SidebarCanvasSection } from "@zui/host/SidebarCanvasSection.js";
import { SidebarNavButton } from "@zui/host/SidebarNavButton.js";
import {
  projectSupportsMode,
  useSharedProjectCatalog,
  useSharedProjectCreation,
  useSharedProjectRefresh,
  useSharedProjectTabRegistration,
} from "@zui/host/SharedProjectNavigation.js";
import { HostSidebarRail, HostWorkbenchModeNavigation } from "@zui/host/WorkbenchModeNavigation.js";
import { useProjectSidebarFileTree } from "@zui/host/useProjectSidebarFileTree.js";
import type { ProjectSidebarProps, ProjectSidebarView, VirtualProject } from "@zui/project-sidebar/contract.js";
import { ProjectCreation } from "@zui/project-sidebar/ProjectCreation.js";
import { ProjectSidebarListHeader } from "@zui/project-sidebar/ProjectSidebarListHeader.js";
import { ProjectSidebarNavigation } from "@zui/project-sidebar/ProjectSidebarNavigation.js";
import { ProjectSidebarNode, runProjectAction as action } from "@zui/project-sidebar/ProjectSidebarNode.js";
import { ProjectSections } from "@zui/project-sidebar/ProjectSections.js";
import { ProjectTaskListContext } from "@zui/project-sidebar/ProjectTaskListContext.js";
import { ProjectTaskRows } from "@zui/project-sidebar/ProjectTaskRows.js";
import { SortableProjects } from "@zui/project-sidebar/SortableProjects.js";
import { TaskGroupedView } from "@zui/project-sidebar/TaskGroupedView.js";
import { taskGroupKey } from "@zui/project-sidebar/grouped-view.js";
import { useProjectDirectory } from "@zui/project-sidebar/ProjectDirectoryProvider.js";
import { useProjectPinIntent } from "@zui/project-sidebar/useProjectPinIntent.js";
import { useProjectTaskNavigation } from "@zui/project-sidebar/useProjectTaskNavigation.js";
import { projectHasUnread, projectKey, selectProjectRows, selectSortedProjects } from "@zui/project-sidebar/view.js";

export { readProjectSidebarView } from "@zui/project-sidebar/view-preference.js";
export { ArchiveManagement } from "@zui/project-sidebar/ArchiveManagement.js";
export { ProjectDirectoryProvider, useOptionalProjectDirectory } from "@zui/project-sidebar/ProjectDirectoryProvider.js";
export { ProjectComposerMenu } from "@zui/project-sidebar/ProjectComposerMenu.js";
export type { SidebarFileTreeOpenRequest, ProjectSidebarProps } from "@zui/project-sidebar/contract.js";

const NOOP_SUBSCRIBE = () => () => {};

function SharedSidebarNavigation({
  props,
  collapsed = false,
}: {
  props: ProjectSidebarProps;
  collapsed?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const openSettings = useTabStore((state) => state.openSettingsTab);
  return <>
    {props.onOpenPluginStore ? <SidebarNavButton
      collapsed={collapsed}
      icon={<Blocks className="size-4" />}
      label={intl.formatMessage({ id: "workspace.openPluginsSettings" })}
      onClick={() => props.onOpenPluginStore?.()}
      active={props.pluginStoreActive}
      testId="plugin-store-sidebar-open"
    /> : null}
    {platform?.skillsSettingsCapabilities?.databaseRecords ? <SidebarNavButton
      collapsed={collapsed}
      icon={<WandSparkles className="size-4" />}
      label={intl.formatMessage({ id: "settings.skills.title" })}
      onClick={() => {
        setPendingSettingsSectionIntent("skill", { pluginScopeKey: "user" });
        openSettings();
      }}
    /> : null}
    {platform?.mcpSettingsCapabilities?.databaseRecords ? <SidebarNavButton
      collapsed={collapsed}
      icon={<Cable className="size-4" />}
      label={intl.formatMessage({ id: "settings.mcpTitle" })}
      onClick={() => {
        setPendingSettingsSectionIntent("mcp", { pluginScopeKey: "user" });
        openSettings();
      }}
    /> : null}
    <PluginSidebarNavigation collapsed={collapsed} />
  </>;
}

function SidebarFooter({ props }: { props: ProjectSidebarProps }) {
  const { localePreference, setLocalePreference } = useZCodeIntl();
  const setTheme = useZCodeStore((state) => state.setTheme);
  const openSettings = useTabStore((state) => state.openSettingsTab);
  const activeTaskId = useZCodeSessionStore((state) =>
    state.workspaces[props.workspaceIdentity?.trim() || props.workspacePath]?.activeTaskId ?? null,
  );
  const changeLocale = useCallback((value: string) => {
    if (value === "system" || value === "zh-CN" || value === "en-US")
      setLocalePreference(value);
  }, [setLocalePreference]);
  const changeTheme = useCallback((value: string) => {
    if (value === "light" || value === "dark" || value === "zai-light" || value === "zai-dark" || value === "system")
      setTheme(value);
  }, [setTheme]);
  return <WorkspaceSidebarFooter
    className="pr-3"
    theme={props.theme}
    localeMenuValue={localePreference}
    onLocaleChange={changeLocale}
    onThemeChange={changeTheme}
    onSettingsButtonClick={openSettings}
    onUsageClick={openSettings}
    workspacePath={props.workspacePath}
    workspaceIdentity={props.workspaceIdentity}
    workspaceRemoteSessionId={props.workspaceRemoteSessionId}
    activeTaskId={activeTaskId}
    isDesktop={props.isDesktop}
  />;
}

function SidebarProjectDialogs({
  props,
  editingProjectId,
  closeEditor,
}: {
  props: ProjectSidebarProps;
  editingProjectId: string | null;
  closeEditor(): void;
}) {
  const { service, refresh } = useProjectDirectory();
  const projectCreation = useSharedProjectCreation();
  const sharedRefresh = useSharedProjectRefresh();
  const creation = projectCreation?.creation;
  const refreshProjects = useCallback(async () => {
    await sharedRefresh?.();
    await refresh();
  }, [sharedRefresh, refresh]);
  useEffect(() => {
    if (creation) closeEditor();
  }, [creation, closeEditor]);
  return <>
    {editingProjectId && service ? <ProjectEditorAdapter
      key={editingProjectId}
      projectId={editingProjectId}
      service={service}
      refreshProjects={refreshProjects}
      onClose={closeEditor}
    /> : null}
    {creation && service && projectCreation ? <ProjectCreation
      key={creation.creationId}
      creation={creation}
      workspacePath={props.workspacePath}
      workspaceIdentity={props.workspaceIdentity}
      service={service}
      onPrepareCreation={prepareProjectCreation}
      onSaved={refreshProjects}
      onClose={() => projectCreation.closeProjectCreation(creation.creationId)}
    /> : null}
  </>;
}

function DesignSidebarViewSwitch({
  canvasSection,
  setCanvasSection,
  view,
  setView,
}: {
  canvasSection: boolean;
  setCanvasSection(value: boolean): void;
  view: ProjectSidebarView;
  setView(value: ProjectSidebarView): void;
}) {
  const { intl } = useZCodeIntl();
  return <Tabs
    value={canvasSection ? "canvas" : view === "grouped" ? "grouped" : "workspace"}
    onValueChange={(value) => {
      setCanvasSection(value === "canvas");
      if (value === "grouped") setView("grouped");
      if (value === "workspace" && view === "grouped") setView("projects");
    }}
    className="w-fit shrink-0 px-2 pb-2"
    aria-label={intl.formatMessage({ id: "workspaceSidebar.organize" })}
  >
    <TabsList className="h-7 w-fit rounded-full bg-surface p-0.5 group-data-horizontal/tabs:h-7">
      <TabsTrigger value="grouped" className="h-6 gap-1 rounded-full px-2 text-ui-sm">
        <Hash aria-hidden="true" className="size-3 shrink-0" />
        {intl.formatMessage({ id: "workspaceSidebar.organizeGrouped" })}
      </TabsTrigger>
      <TabsTrigger value="workspace" className="h-6 gap-1 rounded-full px-2 text-ui-sm">
        <Folder aria-hidden="true" className="size-3 shrink-0" />
        {intl.formatMessage({ id: "workspaceSidebar.organizeByProject" })}
      </TabsTrigger>
      <TabsTrigger value="canvas" className="h-6 gap-1 rounded-full px-2 text-ui-sm">
        <Palette aria-hidden="true" className="size-3 shrink-0" />
        {intl.formatMessage({ id: "workspaceSidebar.organizeCanvas" })}
      </TabsTrigger>
    </TabsList>
  </Tabs>;
}

export const ProjectSidebar = memo(function ProjectSidebar(props: ProjectSidebarProps) {
  useSharedProjectTabRegistration();
  const { tree: authoritativeTree, service, refresh, error, loading, preferences, groups } = useProjectDirectory();
  const platform = useOptionalPlatform();
  const navigation = platform?.workbenchNavigation;
  const workbenchMode = useSyncExternalStore(
    navigation?.subscribe ?? NOOP_SUBSCRIBE,
    () => navigation?.getSnapshot().mode ?? "code",
  );
  const catalog = useSharedProjectCatalog();
  const visibleTree = useMemo(() => {
    if (!catalog) return authoritativeTree;
    const preset = workbenchMode === "design" ? "design" : "code";
    const visibleProjects = new Set(catalog.filter((project) => projectSupportsMode(project, preset)).map((project) => project.projectId));
    const knownProjects = new Set(authoritativeTree.projects.map((project) => project.id));
    return {
      ...authoritativeTree,
      projects: authoritativeTree.projects.filter((project) => visibleProjects.has(project.id)),
      tasks: authoritativeTree.tasks.filter((task) => visibleProjects.has(task.projectId) || !knownProjects.has(task.projectId)),
    };
  }, [authoritativeTree, catalog, workbenchMode]);
  const { tree, pin } = useProjectPinIntent(visibleTree);
  const onSelectTask = useProjectTaskNavigation(props, tree);
  const { isFileTreeOpen, fileTree, openFiles, openTaskFiles } = useProjectSidebarFileTree(props);
  const { intl } = useZCodeIntl();
  const { view, setView } = preferences;
  const projectCreation = useSharedProjectCreation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [groupedToolbar, setGroupedToolbar] = useState<HTMLDivElement | null>(null);
  const [groupedSticky, setGroupedSticky] = useState<HTMLDivElement | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const closeEditor = useCallback(() => setEditingProjectId(null), []);
  const editProject = useCallback(({ project }: { project: VirtualProject }) => {
    setEditingProjectId(project.id);
  }, []);
  const [canvasSection, setCanvasSection] = useState(false);
  const showCanvas = workbenchMode === "design" && canvasSection;
  const activeCanvasProjectId = parseLocalWorkspaceIdentity(props.workspaceIdentity, props.workspacePath)?.projectId ?? null;
  const workspaceReadOnly = useTabStore((state) => isWorkspaceReadOnly(state, props.workspacePath, props.workspaceIdentity));
  const workspaceReadOnlyReason = workspaceReadOnly
    ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
    : undefined;
  const taskPresentation = useMemo(() => ({
    activeWorkspaceKey: props.workspaceIdentity?.trim() || props.workspacePath,
    onPin: pin,
    onOpenTaskFiles: openTaskFiles,
  }), [props.workspaceIdentity, props.workspacePath, pin, openTaskFiles]);
  const createGlobalTask = useCallback(() => {
    if (workspaceReadOnly) return;
    props.onCreateTask(view === "grouped"
      ? { groupedDraftPlacement: { type: "top" } }
      : { createSource: "project" });
  }, [props.onCreateTask, view, workspaceReadOnly]);
  const start = (groupId?: string | null) => {
    if (workspaceReadOnly) return;
    if (view !== "grouped") {
      props.onCreateTask({ createSource: "project" });
      return;
    }
    if (groupId !== undefined) {
      props.onCreateTask({
        groupedDraftPlacement: groupId ? { type: "group", groupId } : { type: "top" },
      });
      return;
    }
    const draft = useZCodeSessionStore
      .getState()
      .getWorkspaceState(props.workspacePath, props.workspaceIdentity);
    if (draft.activeTaskId) {
      const inheritedGroup = groups.parents.get(taskGroupKey({
        taskId: draft.activeTaskId,
        workspacePath: props.workspacePath,
        workspaceIdentity: props.workspaceIdentity,
      }));
      props.onCreateTask({
        groupedDraftPlacement: inheritedGroup
          ? { type: "group", groupId: inheritedGroup }
          : { type: "top" },
      });
      return;
    }
    props.onCreateTask({
      groupedDraftPlacement: draft.groupedDraftTask?.placement ?? { type: "top" },
    });
  };
  const projects = preferences.sort(selectSortedProjects(tree));
  const hasExpandedProjects = projects.some(preferences.isExpanded);
  const reorder = (active: string, over: string) => {
    const source = projects.find((project) => projectKey(project) === active);
    const target = projects.find((project) => projectKey(project) === over);
    if (!source || !target || source.pinned !== target.pinned) return;
    preferences.reorder(projects.filter((project) => project.pinned === source.pinned), active, over);
  };
  const renderProject = (project: VirtualProject) => (
    <ProjectSidebarNode
      key={projectKey(project)}
      project={project}
      expanded={preferences.isExpanded(project)}
      onExpandedChange={preferences.setExpanded}
      hasUnread={projectHasUnread(authoritativeTree, project)}
      tasks={selectProjectRows(tree, {
        kind: "project",
        projectId: project.id,
        hostId: project.hostId,
      })}
      onSelect={onSelectTask}
      refresh={refresh}
      service={service}
      onCreateTask={props.onCreateTask}
      onEdit={editProject}
      onViewFiles={openFiles}
    />
  );
  const dialogs = (
    <SidebarProjectDialogs
      props={props}
      editingProjectId={editingProjectId}
      closeEditor={closeEditor}
    />
  );
  const railMode = props.isSidebarVisible === false &&
    !props.isDesktop && !props.isMacDesktop && !props.isWindowsDesktop;
  if (railMode) return (
    <aside data-testid={TID_SIDEBAR} className="flex h-full flex-col overflow-hidden">
      <HostSidebarRail
        onExpand={() => props.onToggleSidebar?.()}
        actions={<>
          <SidebarNavButton
            collapsed
            icon={<MessageCirclePlus className="size-4" />}
            label={intl.formatMessage({ id: "sidebar.newTask" })}
            hint={workspaceReadOnlyReason}
            disabled={workspaceReadOnly}
            onClick={createGlobalTask}
          />
          <SidebarNavButton
            collapsed
            icon={<Search className="size-4" />}
            label={intl.formatMessage({ id: "commandCenter.open" })}
            onClick={props.onOpenCommandCenter}
          />
          <SharedSidebarNavigation props={props} collapsed />
        </>}
      />
      {dialogs}
    </aside>
  );
  return (
    <ProjectTaskListContext.Provider value={taskPresentation}>
      <SidebarTooltipProvider>
        <aside data-testid={TID_SIDEBAR} className="flex h-full min-h-0 flex-col overflow-hidden">
          {props.isMacDesktop ? <div className="h-12 shrink-0 [app-region:drag]" /> : null}
          <HostWorkbenchModeNavigation
            actions={!props.isMacDesktop && props.isSidebarVisible !== false ? (
              <button
                type="button"
                aria-label="收起侧栏"
                title="收起侧栏"
                onClick={props.onToggleSidebar}
                className="rounded-md p-1 text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                <PanelLeftClose className="size-4" />
              </button>
            ) : undefined}
          />
          <HostModeSidebarContent
            shared={<div className="flex flex-col gap-1 px-2 pt-2"><SharedSidebarNavigation props={props} /></div>}
          >
            <div className="relative min-h-0 flex-1 overflow-clip">
              <div
                data-project-sidebar-panel="navigation"
                className={cn(
                  "absolute inset-0 flex min-h-0 flex-col",
                  isFileTreeOpen && "-translate-x-full pointer-events-none",
                )}
                aria-hidden={isFileTreeOpen}
                inert={isFileTreeOpen}
              >
                <ProjectSidebarNavigation
                  disabled={workspaceReadOnly}
                  props={{
                    ...props,
                    onOpenPluginStore: undefined,
                    onOpenAutomations: platform?.supportsAutomations === true
                      ? props.onOpenAutomations
                      : undefined,
                  }}
                  onCreate={createGlobalTask}
                />
                <div
                  data-testid="sidebar-task-list-region"
                  className="flex min-h-0 flex-1 flex-col border-t border-border/50 pt-3 [anchor-name:--sidebar-task-list-divider]"
                >
                  {workbenchMode === "design" ? (
                    <DesignSidebarViewSwitch
                      canvasSection={canvasSection}
                      setCanvasSection={setCanvasSection}
                      view={view}
                      setView={setView}
                    />
                  ) : null}
                  {!showCanvas ? (
                    <ProjectSidebarListHeader
                      onOpenCommandCenter={props.onOpenCommandCenter}
                      view={view}
                      onViewChange={setView}
                      groupedActionsRef={setGroupedToolbar}
                    />
                  ) : null}
                  <div className="relative flex min-h-0 flex-1 flex-col">
                    <div ref={setGroupedSticky} />
                    <ScrollFadeViewport ref={scrollRef} className="overflow-x-hidden">
                      <div className="flex flex-col gap-3 pb-3">
                        {showCanvas ? (
                          <SidebarCanvasSection projectId={activeCanvasProjectId} />
                        ) : view === "projects" ? (
                          <>
                            <ProjectTaskRows
                              kind="pinned"
                              tasks={selectProjectRows(tree, { kind: "pinned" })}
                              onSelect={onSelectTask}
                              refresh={refresh}
                            />
                            <SortableProjects
                              projects={projects.filter((project) => project.pinned)}
                              renderProject={renderProject}
                              onReorder={reorder}
                            />
                            <ProjectSections
                              tree={tree}
                              projects={projects}
                              renderProject={renderProject}
                              onReorder={reorder}
                              loading={loading}
                              onSelect={onSelectTask}
                              refresh={refresh}
                              onCreate={() => action(async () => start())}
                              onAddProject={() => action(async () => {
                                if (!projectCreation) throw new Error("项目创建入口不可用");
                                await projectCreation.createProject(workbenchMode === "design" ? "design" : "code");
                              })}
                              hasExpandedProjects={hasExpandedProjects}
                              canToggleProjects={projects.length > 0}
                              onToggleProjects={() => preferences.setAllExpanded(projects, !hasExpandedProjects)}
                            />
                          </>
                        ) : view === "grouped" ? (
                          <>
                            <ProjectTaskRows
                              kind="pinned"
                              tasks={selectProjectRows(tree, { kind: "pinned" })}
                              onSelect={onSelectTask}
                              refresh={refresh}
                            />
                            <TaskGroupedView
                              tasks={tree.tasks}
                              onSelect={onSelectTask}
                              refresh={refresh}
                              scrollRef={scrollRef}
                              toolbarTarget={groupedToolbar}
                              stickyTarget={groupedSticky}
                              workspacePath={props.workspacePath}
                              workspaceIdentity={props.workspaceIdentity}
                              onOpenAutomations={platform?.supportsAutomations === true ? props.onOpenAutomations : undefined}
                              onCreate={(groupId) => action(async () => start(groupId))}
                            />
                          </>
                        ) : (
                          <ProjectTaskRows
                            key="timeline"
                            kind="timeline"
                            tasks={selectProjectRows(tree, { kind: "timeline" })}
                            onSelect={onSelectTask}
                            refresh={refresh}
                          />
                        )}
                        {loading ? (
                          <p className="px-4 text-ui-sm text-foreground-subtle">
                            {intl.formatMessage({ id: "common.loading" })}
                          </p>
                        ) : null}
                        {error ? <p role="alert" className="px-4 text-ui-sm text-destructive">{error}</p> : null}
                      </div>
                    </ScrollFadeViewport>
                  </div>
                </div>
              </div>
              {fileTree}
            </div>
          </HostModeSidebarContent>
          <SidebarFooter props={props} />
          {dialogs}
        </aside>
      </SidebarTooltipProvider>
    </ProjectTaskListContext.Provider>
  );
});
