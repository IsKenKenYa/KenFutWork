import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import { type ReactNode, useEffect, useState } from "react";
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
interface ChoiceOptions {
  signal?: AbortSignal;
}
interface Request {
  id: number;
  projects: DirectoryProject[];
  purpose: "open" | "relink" | "create";
  finish: (choice: Choice) => void;
}
interface ChoiceOwner {
  active: boolean;
  controller: AbortController;
  choose(
    projects: DirectoryProject[],
    purpose: Request["purpose"],
    signal: AbortSignal,
  ): Promise<Choice>;
  dispose(): void;
}
interface ChoiceOperation {
  owner: ChoiceOwner | null;
  signal: AbortSignal | undefined;
}
let choiceOwner: ChoiceOwner | null = null;

export class DirectoryChoiceCancelledError extends Error {
  constructor() {
    super("已取消目录选择。");
  }
}

function createChoiceOwner(update: (requests: Request[]) => void): ChoiceOwner {
  let requests: Request[] = [];
  let sequence = 0;
  const owner: ChoiceOwner = {
    active: true,
    controller: new AbortController(),
    choose: (projects, purpose, signal) =>
      new Promise<Choice>((resolve) => {
        if (!owner.active || signal.aborted) {
          resolve(null);
          return;
        }
        let settled = false;
        const finish = (choice: Choice) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", cancel);
          requests = requests.filter((item) => item !== request);
          if (owner.active) update([...requests]);
          resolve(choice);
        };
        const cancel = () => finish(null);
        const request: Request = {
          id: ++sequence,
          projects,
          purpose,
          finish,
        };
        requests = [...requests, request];
        signal.addEventListener("abort", cancel, { once: true });
        update([...requests]);
      }),
    dispose: () => {
      owner.active = false;
      if (choiceOwner === owner) choiceOwner = null;
      owner.controller.abort();
      for (const request of requests) request.finish(null);
      requests = [];
    },
  };
  return owner;
}

export function ProjectDirectoryChoiceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [requests, setRequests] = useState<Request[]>([]);
  useEffect(() => {
    const owner = createChoiceOwner(setRequests);
    choiceOwner = owner;
    return () => owner.dispose();
  }, []);
  const current = requests[0];
  const finish = (choice: Choice) => current?.finish(choice);
  return (
    <>
      {children}
      <Dialog
        key={current?.id ?? "idle"}
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
              current.purpose !== "relink" && project.kind !== "flow" ? (
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
          <p className="text-ui-sm text-foreground-subtle">
            独立项目仍共用目录
          </p>
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

function operationIsCurrent(operation: ChoiceOperation) {
  return (
    !operation.signal?.aborted && (!operation.owner || operation.owner.active)
  );
}

async function withChoiceOperation<T>(
  options: ChoiceOptions | undefined,
  run: (operation: ChoiceOperation) => Promise<T>,
): Promise<T | null> {
  const owner = choiceOwner;
  const signals = [owner?.controller.signal, options?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const operation: ChoiceOperation = {
    owner,
    signal: signals.length ? AbortSignal.any(signals) : undefined,
  };
  if (!operationIsCurrent(operation)) return null;
  try {
    const result = await run(operation);
    return operationIsCurrent(operation) ? result : null;
  } catch (error) {
    if (!operationIsCurrent(operation)) return null;
    throw error;
  }
}

async function directoryProjects(path: string, signal?: AbortSignal) {
  return (
    await surfaceJson<{ projects: DirectoryProject[] }>(
      `/api/projects/directory-candidates?path=${encodeURIComponent(path)}`,
      { signal: signal ?? null },
    )
  ).projects;
}
function requestChoice(
  operation: ChoiceOperation,
  projects: DirectoryProject[],
  purpose: Request["purpose"],
) {
  if (!operationIsCurrent(operation)) return Promise.resolve(null);
  if (!operation.owner || !operation.signal)
    throw new Error("请在工作台中选择项目后重新打开目录。");
  return operation.owner.choose(projects, purpose, operation.signal);
}

/** 用户选择只改变项目归属；文件目录本身不复制或迁移。 */
export async function chooseDirectoryProject(
  path: string,
  preset: "code" | "design",
  options?: ChoiceOptions,
): Promise<Choice> {
  return withChoiceOperation<Choice>(options, async (operation) => {
    const projects = await directoryProjects(path, operation.signal);
    if (!projects.length) return { newProject: true };
    const choice = await requestChoice(operation, projects, "open");
    if (!operationIsCurrent(operation)) return null;
    if (choice && "projectId" in choice) {
      const project = projects.find((item) => item.id === choice.projectId);
      if (!project || project.kind === "flow")
        throw new Error("项目不可用，请重新选择。");
      if (!project.enabledModes.includes(preset)) {
        const response = await surfaceFetch(
          `/api/projects/${encodeURIComponent(project.id)}`,
          {
            method: "PATCH",
            signal: operation.signal ?? null,
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
  });
}

/** 创建只确认复用或独立创建，复用保留原项目设置。 */
export async function chooseProjectCreationDirectory(
  path: string,
  options: { signal: AbortSignal },
): Promise<Choice> {
  return withChoiceOperation<Choice>(options, async (operation) => {
    if (!operation.owner)
      throw new Error("请在工作台中选择项目后重新打开目录。");
    const projects = await directoryProjects(path, operation.signal);
    if (!projects.length) return { newProject: true };
    const choice = await requestChoice(operation, projects, "create");
    if (!choice || !("projectId" in choice)) return choice;
    const selected = projects.find(
      (project) => project.id === choice.projectId,
    );
    if (!selected || selected.kind === "flow")
      throw new Error("项目不可用，请重新选择。");
    const latest = await directoryProjects(selected.workDir, operation.signal);
    const project = latest.find((item) => item.id === selected.id);
    if (
      !project ||
      project.kind === "flow" ||
      project.workDir !== selected.workDir
    )
      throw new Error("项目目录已更改，请重新选择。");
    return { projectId: project.id };
  });
}

/** 恢复保留原项目身份，只确认目录共用；不会复用另一项目或启用其工作方式。 */
export async function confirmDirectoryRelink(
  path: string,
  projectId: string,
  options?: ChoiceOptions,
): Promise<"independent" | "unassociated" | null> {
  return withChoiceOperation<"independent" | "unassociated" | null>(
    options,
    async (operation) => {
      const projects = (await directoryProjects(path, operation.signal)).filter(
        (project) => project.id !== projectId,
      );
      if (!projects.length) return "unassociated";
      const choice = await requestChoice(operation, projects, "relink");
      return choice && "independent" in choice ? "independent" : null;
    },
  );
}
