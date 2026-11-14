import type { CreateTaskRequest } from "@zui/app-shell/types.js";
import type { ReactNode } from "react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon } from "@zui/components/ui/input-group.js";
import { ChevronDownIcon, FolderPlus, MessageCircle, Plus, SearchIcon, X } from "lucide-react";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { cn } from "@zui/components/lib/utils.js";
import { logger } from "@zui/logger.js";
import {
  parseLocalWorkspaceIdentity,
  TID_COMPOSER_PROJECT_DETACH,
  TID_COMPOSER_WORK_OUTSIDE_PROJECT,
  TID_COMPOSER_WORKSPACE_TRIGGER,
} from "@zcode/shared";
import { runUserAction, runUserActionAsync } from "@zui/lib/userActionTelemetry.js";
import { ControlHintTooltip } from "@zui/ControlHintTooltip.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@zui/hooks/useWorkspaceServices.js";
import {
  projectSupportsMode,
  useSharedProjectCatalog,
  useSharedProjectCreation,
  useSharedProjectRefresh,
} from "@zui/host/SharedProjectNavigation.js";
import { ProjectEditor } from "@zui/project-sidebar/ProjectEditor.js";
import { ProjectFolderIcon } from "@zui/project-sidebar/ProjectFolderIcon.js";
import { useProjectDirectory } from "@zui/project-sidebar/ProjectDirectoryProvider.js";
import { useOptionalTabStore, useTabStoreApi } from "@zui/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";

export function ProjectComposerMenu({
  workspacePath,
  workspaceIdentity,
  allowConversationWorkspaceSelection = true,
  allowConversationWorkspaceDetach = allowConversationWorkspaceSelection,
  onCreateTask,
  onSelectConversationWorkspace,
  containerClassName,
  triggerClassName,
  triggerIndicator,
  showEditProject = false,
  children,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  allowConversationWorkspaceSelection?: boolean;
  /** 是否显示项目 chip 的快捷脱离按钮；默认跟随非项目工作区选择能力。 */
  allowConversationWorkspaceDetach?: boolean;
  onCreateTask: (request?: CreateTaskRequest) => void;
  onSelectConversationWorkspace: () => void | Promise<void>;
  /** 调用方局部调整 workspace chip 外层视觉，不改变普通会话默认样式。 */
  containerClassName?: string;
  /** 调用方局部调整 workspace trigger 视觉，不改变普通会话默认样式。 */
  triggerClassName?: string;
  /** 调用方局部替换尾部 indicator；普通会话继续使用默认 Lucide chevron。 */
  triggerIndicator?: ReactNode;
  /** 聊天头部启用当前项目编辑，其他项目选择器保持原有入口。 */
  showEditProject?: boolean;
  /** 分支等控件位于项目选择器与编辑按钮之间。 */
  children?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState("");
  const { tree, error, refresh } = useProjectDirectory();
  const service = useBaseWorkspaceServices().projectService;
  const catalog = useSharedProjectCatalog();
  const projectCreation = useSharedProjectCreation();
  const refreshProjects = useSharedProjectRefresh();
  const navigation = useOptionalPlatform()?.workbenchNavigation;
  const mode = useSyncExternalStore(
    navigation?.subscribe ?? (() => () => {}),
    () => navigation?.getSnapshot().mode ?? "code",
  );
  const preset = mode === "design" ? "design" : "code";
  const projects = useMemo(() => {
    const visibleIds = new Set(
      catalog?.filter((project) => projectSupportsMode(project, preset)).map((project) => project.projectId),
    );
    return tree.projects.filter((project) =>
      project.hostId === "local" && !project.deleted && visibleIds.has(project.id),
    );
  }, [tree.projects, catalog, preset]);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const projectId = parseLocalWorkspaceIdentity(workspaceIdentity ?? "", workspacePath)?.projectId;
  const activeTaskId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId,
  );
  const draftVersion = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftFocusVersion,
  );
  const activeTabId = useOptionalTabStore((state) => state.activeTabId);
  const tabs = useTabStoreApi();
  // 草稿重建和聊天切换都会使旧返回意图失效，即使后来又回到同一路径也不能复活旧操作。
  const chatKey = JSON.stringify([workspaceKey, activeTaskId, projectId, draftVersion, activeTabId, mode]);
  const currentChat = useRef({ key: chatKey });
  if (currentChat.current.key !== chatKey) currentChat.current = { key: chatKey };
  const chat = currentChat.current;
  const mounted = useRef(true);
  const [editingChat, setEditingChat] = useState<typeof chat | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = () => {
    const draft = useZCodeSessionStore.getState().workspaces[workspaceKey];
    return (
      mounted.current &&
      currentChat.current === chat &&
      tabs.getState().activeTabId === activeTabId &&
      (!navigation || navigation.getSnapshot().mode === mode) &&
      draft?.activeTaskId === activeTaskId &&
      draft?.draftFocusVersion === draftVersion
    );
  };
  const createProjectTask = (selectedProjectId: string) => {
    if (!isCurrent()) return;
    const draft = useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity);
    const placement = !draft.activeTaskId ? draft.groupedDraftTask?.placement : undefined;
    onCreateTask({
      projectId: selectedProjectId,
      ...(placement ? { groupedDraftPlacement: placement } : {}),
      isCurrent,
    });
  };
  const refreshDirectory = useCallback(async () => {
    await refreshProjects?.();
    await refresh();
  }, [refresh, refreshProjects]);
  // 目录可以属于多个项目；只按宿主登记的完整项目身份匹配当前草稿。
  const currentProject = projects.find((project) => project.id === projectId);
  const canEditProject = showEditProject && currentProject && Boolean(service);
  const isConversationWorkspace = !currentProject;
  const canDetachProject =
    allowConversationWorkspaceSelection &&
    allowConversationWorkspaceDetach &&
    !isConversationWorkspace;
  const visibleProjects = useMemo(() => {
    const query = workspaceSearchQuery.trim().toLowerCase();
    return projects.filter((project) =>
      [project.name, ...project.roots.map((root) => root.rootPath)].some((text) =>
        text.toLowerCase().includes(query),
      ),
    );
  }, [projects, workspaceSearchQuery]);
  const currentWorkspaceTitle =
    currentProject?.name ?? intl.formatMessage({ id: "chat.empty.selectProject" });
  const currentWorkspaceIconClassName = cn(
    "size-4 text-foreground-subtle transition-opacity",
    // 关闭按钮和项目图标占用同一位置。只有允许脱离项目时才隐藏底层图标。
    canDetachProject &&
      "group-hover/workspace-chip:opacity-0 group-focus-within/workspace-chip:opacity-0",
  );

  const menu = (
    <DropdownMenu>
      <div
        className={cn(
          "group/workspace-chip relative flex min-w-0 items-center rounded-full hover:bg-surface-hover focus-within:bg-surface-hover",
          containerClassName,
        )}
      >
        {canDetachProject ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="pointer-events-none absolute left-1.5 z-10 rounded-full text-foreground-subtle opacity-0 transition-opacity group-hover/workspace-chip:pointer-events-auto group-hover/workspace-chip:opacity-100 group-focus-within/workspace-chip:pointer-events-auto group-focus-within/workspace-chip:opacity-100"
            aria-label={intl.formatMessage({ id: "chat.empty.detachProject" })}
            data-testid={TID_COMPOSER_PROJECT_DETACH}
            onClick={(event) => {
              event.stopPropagation();
              void runUserActionAsync({
                input: {
                  featureId: "workspace.project_binding",
                  action: "detach",
                  trigger: "button",
                },
                operation: () => Promise.resolve(onSelectConversationWorkspace()),
                completed: { resultSource: "optimistic_projection" },
                failureStage: "project_detach",
              });
            }}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            className={cn(
              "min-w-0 rounded-full bg-transparent text-ui-base/relaxed hover:bg-transparent",
              "max-w-[15rem] pl-3 pr-2",
              triggerClassName,
            )}
            aria-label={intl.formatMessage({ id: "chat.empty.workspaceMenu" })}
            data-testid={TID_COMPOSER_WORKSPACE_TRIGGER}
          >
            <ProjectFolderIcon
              rootCount={currentProject?.roots.length ?? 0}
              className={currentWorkspaceIconClassName}
            />
            <span className="block max-w-full truncate">{currentWorkspaceTitle}</span>
            {triggerIndicator ?? <ChevronDownIcon className="size-3.5 text-foreground-subtle" />}
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        data-testid="composer-project-menu"
        align="start"
        side="top"
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col p-0"
      >
        <div
          data-slot="command-input-wrapper"
          className="shrink-0 p-1 border-b border-border"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <InputGroup className="h-8 border-0 !bg-transparent hover:border-input-border-hover ">
            <input
              data-slot="command-input"
              value={workspaceSearchQuery}
              placeholder={intl.formatMessage({ id: "chat.empty.workspaceSearchPlaceholder" })}
              onChange={(event) => setWorkspaceSearchQuery(event.target.value)}
              className="w-full text-ui-base/relaxed text-foreground outline-hidden placeholder:text-foreground-subtlest disabled:cursor-not-allowed disabled:opacity-50"
            />
            <InputGroupAddon>
              <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="flex min-h-0 flex-col p-1">
          {error ? (
            <div role="alert" className="px-2 py-2 text-ui-base text-destructive">
              {error}
            </div>
          ) : null}
          <div className="min-h-0 max-h-60 overflow-y-auto">
            {visibleProjects.map((project) => (
              <span key={project.id} className="block min-w-0">
                <DropdownMenuCheckboxItem
                  data-project-id={project.id}
                  data-project-host={project.hostId}
                  data-project-name={project.name}
                  checked={currentProject === project}
                  onSelect={() => {
                    logger.info("[ProjectComposerMenu] 选择项目", {
                      projectId: project.id,
                      hostId: project.hostId,
                    });
                    runUserAction({
                      input: {
                        featureId: "workspace.project_binding",
                        action: isConversationWorkspace ? "attach" : "switch",
                        trigger: "menu",
                        workspaceKind: "local",
                      },
                      // 同侧栏项目新建入口：由 Root/Host 解析项目的当前主要目录。
                      operation: () => createProjectTask(project.id),
                      completed: { resultSource: "local_commit" },
                      failureStage: "project_switch",
                    });
                  }}
                >
                  <ProjectFolderIcon rootCount={project.roots.length} className="size-4 text-foreground-subtle" />
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  </span>
                </DropdownMenuCheckboxItem>
              </span>
            ))}
            {visibleProjects.length === 0 && !error ? (
              <div className="px-2 py-2 text-ui-base text-foreground-subtlest">
                {intl.formatMessage({ id: "chat.empty.workspaceSearchEmpty" })}
              </div>
            ) : null}
          </div>
          <div className="shrink-0">
            <DropdownMenuSeparator />
            {projectCreation ? (
              <DropdownMenuItem
                data-testid="composer-create-project"
                onSelect={() => void projectCreation.createProject(preset)}
              >
                <FolderPlus className="size-4 text-foreground-subtle" />
                <span>{intl.formatMessage({ id: "project.create" })}</span>
              </DropdownMenuItem>
            ) : null}
            {allowConversationWorkspaceSelection ? (
              <DropdownMenuCheckboxItem
                data-testid={TID_COMPOSER_WORK_OUTSIDE_PROJECT}
                checked={isConversationWorkspace}
                onSelect={() =>
                  void runUserActionAsync({
                    input: {
                      featureId: "workspace.project_binding",
                      action: "work_outside_project",
                      trigger: "menu",
                    },
                    operation: () => Promise.resolve(onSelectConversationWorkspace()),
                    completed: { resultSource: "optimistic_projection" },
                    failureStage: "project_detach",
                  })
                }
              >
                <MessageCircle className="size-4 text-foreground-subtle" />
                <span>{intl.formatMessage({ id: "chat.empty.workOutsideProject" })}</span>
              </DropdownMenuCheckboxItem>
            ) : null}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <>
      {catalog && service ? menu : null}
      {children}
      {catalog && canEditProject ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "project.edit" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-foreground-subtle"
            aria-label={intl.formatMessage({ id: "project.edit" })}
            data-testid="composer-edit-project"
            onClick={() => setEditingChat(chat)}
          >
            <Plus className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {catalog && editingChat === chat && canEditProject && currentProject && service ? (
        <ProjectEditor
          key={currentProject.id}
          project={currentProject}
          service={service}
          isCurrent={isCurrent}
          onClose={() => setEditingChat(null)}
          onSaved={refreshDirectory}
          onDeleted={async () => {
            await refreshDirectory();
            window.dispatchEvent(new CustomEvent("kenfutwork:project-deleted", {
              detail: { projectId: currentProject.id },
            }));
          }}
        />
      ) : null}
    </>
  );
}
