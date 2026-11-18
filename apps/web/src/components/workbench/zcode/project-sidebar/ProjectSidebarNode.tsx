import { memo } from "react";
import { shallow } from "zustand/shallow";
import type { IProjectService, VirtualProject, ProjectSidebarProps } from "@zui/project-sidebar/contract.js";
import { ProjectNode } from "@zui/project-sidebar/ProjectNode.js";
import type { ProjectNodeProps } from "@zui/project-sidebar/ProjectNodeContent.js";
import { useConfirmDialog } from "@zui/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { toast } from "@zui/components/ui/toast.js";
import { logger } from "@zui/logger.js";

export function runProjectAction(body: () => Promise<void>) {
  void body().catch((cause) => {
    logger.error("[project-sidebar] 操作失败", cause);
    toast(String(cause));
  });
}
type Props = Pick<ProjectNodeProps,
  "project" | "expanded" | "hasUnread" | "tasks" | "onSelect" | "refresh"
> & Pick<ProjectSidebarProps, "onCreateTask"> & {
  service?: IProjectService;
  onExpandedChange(project: VirtualProject, expanded: boolean): void;
  onEdit(value: { project: VirtualProject }): void;
  onViewFiles(project: VirtualProject, rootPath: string): Promise<void>;
};

export const ProjectSidebarNode = memo(function ProjectSidebarNode({
  project, service, onCreateTask, onExpandedChange, onEdit, onViewFiles, ...display
}: Props) {
  const { intl } = useZCodeIntl();
  const confirm = useConfirmDialog();
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  const { refresh } = display;
  return <ProjectNode
    {...display}
    project={project}
    onExpandedChange={(expanded) => onExpandedChange(project, expanded)}
    onCreate={() => onCreateTask({ projectId: project.id, groupedDraftPlacement: { type: "top" } })}
    onEdit={() => onEdit({ project })}
    onViewFiles={(rootPath) => runProjectAction(() => onViewFiles(project, rootPath))}
    onDelete={() => runProjectAction(async () => {
      if (!service) throw new Error("project.service-unavailable");
      await service.deleteProject(project.id, project.hostId);
      await refresh();
    })}
    onPin={() => runProjectAction(async () => {
      if (!service) throw new Error("project.service-unavailable");
      await service.saveProject({ id: project.id, hostId: project.hostId, expectedRevision: project.revision, pinned: !project.pinned });
      await refresh();
    })}
    onMove={(task) => runProjectAction(async () => {
      if (!service) throw new Error("project.service-unavailable");
      const intent: Parameters<IProjectService["moveTask"]>[0] = {
        task: { taskId: task.sessionId, workspacePath: task.workspacePath, workspaceIdentity: task.workspaceIdentity },
        sourceProjectId: task.sourceProjectId,
        observedRevision: task.observedRevision,
        projectId: project.id,
        hostId: "local",
      };
      try {
        await service.moveTask(intent);
      } catch (cause) {
        if (!String(cause).includes("project.root-confirmation-required")) throw cause;
        if (!(await confirm({ title: msg("addFolder"), description: task.workspacePath }))) return;
        await service.moveTask({ ...intent, addMissingRoot: true });
      }
      await refresh();
    })}
  />;
}, (previous, next) => {
  const { tasks: previousTasks, ...previousProps } = previous;
  const { tasks: nextTasks, ...nextProps } = next;
  return shallow(previousProps, nextProps) && shallow(previousTasks, nextTasks);
});
