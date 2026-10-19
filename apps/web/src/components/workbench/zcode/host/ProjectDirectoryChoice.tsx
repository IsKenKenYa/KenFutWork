import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { surfaceFetch, surfaceJson } from "./surfaceApi.js";

export interface DirectoryProject {
  id: string;
  name: string;
  kind: "code" | "design" | "flow";
  enabledModes: Array<"code" | "design" | "flow">;
  workDir: string;
}
type Choice =
  | { projectId: string }
  | { independent: true }
  | { newProject: true }
  | null;
interface Request {
  projects: DirectoryProject[];
  purpose: "open" | "relink";
  resolve: (choice: Choice) => void;
}
let choose: ((request: Omit<Request, "resolve">) => Promise<Choice>) | null =
  null;

export class DirectoryChoiceCancelledError extends Error {
  constructor() {
    super("已取消目录选择。");
  }
}

export function ProjectDirectoryChoiceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [requests, setRequests] = useState<Request[]>([]);
  const pending = useRef<Request[]>([]);
  useEffect(() => {
    const requestChoice = (request: Omit<Request, "resolve">) =>
      new Promise<Choice>((resolve) => {
        pending.current = [...pending.current, { ...request, resolve }];
        setRequests(pending.current);
      });
    choose = requestChoice;
    return () => {
      if (choose === requestChoice) choose = null;
      pending.current.forEach((request) => {
        request.resolve(null);
      });
      pending.current = [];
    };
  }, []);
  const current = requests[0];
  const finish = (choice: Choice) => {
    pending.current[0]?.resolve(choice);
    pending.current = pending.current.slice(1);
    setRequests(pending.current);
  };
  return (
    <>
      {children}
      <Dialog
        open={Boolean(current)}
        onOpenChange={(open) => {
          if (!open) finish(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>目录已关联项目</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {current?.projects.map((project) =>
              current.purpose === "open" && project.kind !== "flow" ? (
                <Button
                  key={project.id}
                  variant="outline"
                  onClick={() => finish({ projectId: project.id })}
                >
                  {project.name}
                </Button>
              ) : (
                <span key={project.id}>{project.name}</span>
              ),
            )}
          </div>
          <p className="text-xs text-foreground-subtle">独立项目仍共用目录</p>
          <Button onClick={() => finish({ independent: true })}>
            {current?.purpose === "relink" ? "共用目录" : "独立创建"}
          </Button>
          <Button variant="ghost" onClick={() => finish(null)}>
            取消
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

async function directoryProjects(path: string) {
  return (
    await surfaceJson<{ projects: DirectoryProject[] }>(
      `/api/projects/directory-candidates?path=${encodeURIComponent(path)}`,
    )
  ).projects;
}
function requestChoice(
  projects: DirectoryProject[],
  purpose: Request["purpose"],
) {
  if (!choose) throw new Error("请在工作台中选择项目后重新打开目录。");
  return choose({ projects, purpose });
}

/** 用户选择只改变项目归属；文件目录本身不复制或迁移。 */
export async function chooseDirectoryProject(
  path: string,
  preset: "code" | "design",
): Promise<Choice> {
  const projects = await directoryProjects(path);
  if (!projects.length) return { newProject: true };
  const choice = await requestChoice(projects, "open");
  if (choice && "projectId" in choice) {
    const project = projects.find((item) => item.id === choice.projectId);
    if (!project || project.kind === "flow")
      throw new Error("项目不可用，请重新选择。");
    if (!project.enabledModes.includes(preset)) {
      const response = await surfaceFetch(
        `/api/projects/${encodeURIComponent(project.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled_modes: [...project.enabledModes, preset],
          }),
        },
      );
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error?.message ?? "无法共享项目，请重新选择。");
      }
    }
  }
  return choice;
}

/** 恢复保留原项目身份，只确认目录共用；不会复用另一项目或启用其工作方式。 */
export async function confirmDirectoryRelink(
  path: string,
  projectId: string,
): Promise<"independent" | "unassociated" | null> {
  const projects = (await directoryProjects(path)).filter(
    (project) => project.id !== projectId,
  );
  if (!projects.length) return "unassociated";
  const choice = await requestChoice(projects, "relink");
  return choice && "independent" in choice ? "independent" : null;
}
