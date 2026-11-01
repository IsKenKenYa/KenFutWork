import type { ProjectSummary } from "@kenfutwork/shared";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
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

/** Code 侧栏的项目清单：直接列出全部项目，不藏在弹层里。 */
export function AllProjectsList() {
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
    <div className="flex min-h-0 flex-col px-2 pb-2">
      <div className="flex items-center justify-between px-1 py-1 text-xs text-foreground-subtle">
        <span>全部项目</span>
        {loading ? null : <span>{projects.length}</span>}
      </div>
      {error ? (
        <p role="alert" className="px-1 pb-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="max-h-64 min-h-0 overflow-y-auto">
        {KIND_GROUPS.map((group) => {
          const items = projects.filter(
            (project) => project.kind === group.kind,
          );
          if (items.length === 0) return null;
          return (
            <div key={group.kind}>
              <p className="px-1 pt-2 pb-0.5 text-[11px] text-foreground-subtle">
                {group.label}
              </p>
              {items.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => open(project)}
                  className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-surface-hover"
                >
                  <span className="truncate">{project.name}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
