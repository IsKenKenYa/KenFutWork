import type { ProjectSummary } from "@kenfutwork/shared";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { FolderTree } from "lucide-react";
import { useEffect, useState } from "react";
import { listProjects, selectFlowProject } from "./flowProjects.js";
import { useSharedProjectNavigation } from "./SharedProjectNavigation.js";

const KIND_GROUPS = [
  { kind: "code", label: "编码" },
  { kind: "design", label: "画布" },
  { kind: "work", label: "工作" },
  { kind: "flow", label: "流程" },
] as const;

/** 项目选中后落到哪个工作方式；Flow 项目保持独立，只切换并选中。 */
export function resolveProjectTarget(project: ProjectSummary) {
  if (project.kind === "flow") return { mode: "flow" as const };
  return {
    mode: project.kind === "design" ? ("design" as const) : ("code" as const),
    preset: project.kind === "design" ? ("design" as const) : ("code" as const),
  };
}

/** Code 模式的「全部项目」：画布 / 编码 / 工作 / 流程都在这里可见。 */
export function AllProjectsMenu() {
  const navigation = useOptionalPlatform()?.workbenchNavigation;
  const shared = useSharedProjectNavigation();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    listProjects()
      .then((next) => {
        if (!current) return;
        setProjects(next);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (!current) return;
        setError(
          failure instanceof Error ? failure.message : "项目读取失败，请重试。",
        );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, []);

  const open = (project: ProjectSummary) => {
    const target = resolveProjectTarget(project);
    if (target.mode === "flow") {
      selectFlowProject(project.id);
      navigation?.open("flow");
      return;
    }
    if (!shared) {
      navigation?.open(target.preset);
      return;
    }
    void (async () => {
      try {
        let workspace = shared.projects.find(
          (item) => item.projectId === project.id,
        );
        if (!workspace) {
          // 菜单直读 /api/projects，可能比 Code 的工作区目录更新一步。
          const refreshed = await shared.refreshWorkspaces();
          workspace = refreshed.find((item) => item.projectId === project.id);
        }
        if (!workspace) {
          navigation?.open(target.preset);
          return;
        }
        await shared.openProject(workspace, target.preset);
      } catch (failure) {
        setError(
          failure instanceof Error ? failure.message : "项目打开失败，请重试。",
        );
      }
    })();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="w-full justify-start gap-2 px-2 text-foreground"
          aria-label="全部项目"
        >
          <FolderTree className="size-4 shrink-0" />
          <span className="truncate">全部项目</span>
          {loading ? null : (
            <span className="ml-auto text-xs text-foreground-subtle">
              {projects.length}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        {error ? (
          <DropdownMenuItem disabled className="text-destructive">
            {error}
          </DropdownMenuItem>
        ) : null}
        {!error && !loading && projects.length === 0 ? (
          <DropdownMenuItem disabled>暂无项目</DropdownMenuItem>
        ) : null}
        {KIND_GROUPS.map((group) => {
          const items = projects.filter(
            (project) => project.kind === group.kind,
          );
          if (items.length === 0) return null;
          return (
            <div key={group.kind}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-foreground-subtle">
                {group.label}
              </DropdownMenuLabel>
              {items.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  onSelect={() => open(project)}
                >
                  <span className="truncate">{project.name}</span>
                </DropdownMenuItem>
              ))}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
