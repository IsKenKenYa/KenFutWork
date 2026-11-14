import type { ReactNode } from "react";
import { SortableProjects } from "@zui/project-sidebar/SortableProjects.js";
import type {
  ProjectSidebarProps,
  ProjectTree,
  VirtualProject,
} from "@zui/project-sidebar/contract.js";
import { selectProjectRows } from "@zui/project-sidebar/view.js";
import { ProjectTaskRows } from "@zui/project-sidebar/ProjectTaskRows.js";
import { PurposeSections } from "@zui/project-sidebar/PurposeSections.js";
export function ProjectSections({
  tree,
  projects,
  renderProject,
  onSelect,
  refresh,
  onCreate,
  onAddProject,
  hasExpandedProjects,
  canToggleProjects,
  onToggleProjects,
  onReorder,
  loading,
}: {
  tree: ProjectTree;
  projects: VirtualProject[];
  renderProject(project: VirtualProject): ReactNode;
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
  onCreate(): void;
  onAddProject(): void;
  hasExpandedProjects: boolean;
  canToggleProjects: boolean;
  onToggleProjects(): void;
  onReorder(active: string, over: string): void;
  loading: boolean;
}) {
  const localTasks = selectProjectRows(tree, { kind: "project", projectId: null }).filter(
    (task) => task.hostId === "local",
  );
  return (
    <PurposeSections
      onAdd={onAddProject}
      hasExpandedProjects={hasExpandedProjects}
      canToggleProjects={canToggleProjects}
      onToggleProjects={onToggleProjects}
      onCreate={onCreate}
      projects={
        <SortableProjects
          projects={projects.filter((project) => !project.pinned)}
          renderProject={renderProject}
          onReorder={onReorder}
        />
      }
      tasks={
        // 原因：任务分区遗漏项目内列表的左侧留白，导致整行背景和文字贴左；统一内缩 8px。
        <div className="pl-2">
          <ProjectTaskRows
            tasks={localTasks}
            onSelect={onSelect}
            refresh={refresh}
            showEmptyState={!loading}
          />
        </div>
      }
    />
  );
}
