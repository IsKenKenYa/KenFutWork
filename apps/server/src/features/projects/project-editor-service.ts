import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import type {
  AdditionalDirectory,
  CodeProjectEditorDirectory,
  CodeProjectEditorProject,
  CodeProjectEditorReadDirectory,
  CodeProjectEditorSave,
} from "@kenfutwork/shared";
import { codeProjectEditorDirectorySchema } from "@kenfutwork/shared";
import {
  type CodeUiHostRpcContext,
  CodeUiHostRpcError,
} from "../code-ui/host-rpc-handler.js";
import type { CodeUiService } from "../code-ui/service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type {
  ProjectEditorChange,
  ProjectEditorRepository,
  ProjectEditorRow,
} from "./project-editor-repository.js";
import type { ProjectService } from "./project-service.js";
import { validateWorkDir } from "./work-dir.js";

export interface ProjectEditorService {
  readProjects(actor: LocalActor): Promise<CodeProjectEditorProject[]>;
  readDirectory(
    actor: LocalActor,
    input: CodeProjectEditorReadDirectory,
    context: CodeUiHostRpcContext,
  ): Promise<CodeProjectEditorDirectory>;
  saveProject(
    actor: LocalActor,
    input: CodeProjectEditorSave,
    signal: AbortSignal,
  ): Promise<CodeProjectEditorProject>;
  deleteProject(actor: LocalActor, projectId: string): Promise<void>;
}

function directory(raw: string): string {
  const verdict = validateWorkDir(raw);
  if (!verdict.ok)
    throw new CodeUiHostRpcError("invalid_work_dir", verdict.reason, 400);
  return realpathSync(verdict.path);
}

function projectChange(
  project: ProjectEditorRow,
  input: CodeProjectEditorSave,
): ProjectEditorChange {
  if (!project.work_dir)
    throw new CodeUiHostRpcError(
      "invalid_work_dir",
      "项目目录缺失，请重新关联项目。",
      400,
    );
  const primary = directory(project.work_dir);
  const roots = [...new Set(input.roots.map(directory))];
  if (
    !roots.includes(primary) ||
    (input.primaryRoot && directory(input.primaryRoot) !== primary)
  )
    throw new CodeUiHostRpcError(
      "invalid_work_dir",
      "项目主目录固定，请保留原主目录。",
      400,
    );
  const permissions = new Map<string, AdditionalDirectory["access"]>();
  for (const [path, access] of Object.entries(input.rootPermissions)) {
    const root = directory(path);
    if (
      !roots.includes(root) ||
      (permissions.has(root) && permissions.get(root) !== access) ||
      (root === primary && access !== "read-write")
    )
      throw new CodeUiHostRpcError(
        "invalid_work_dir",
        "目录权限与所选目录不一致，请重新选择。",
        400,
      );
    permissions.set(root, access);
  }
  const previous = new Map(
    project.additional_directories.map((entry) => [entry.path, entry.access]),
  );
  return {
    name: input.name ?? project.name,
    additionalDirectories: roots
      .filter((path) => path !== primary)
      .map((path) => ({
        path,
        access: permissions.get(path) ?? previous.get(path) ?? "read-only",
      })),
  };
}

/** 回执比较原保存意图，不重新依赖已提交之后变化的文件系统。 */
function projectEditFingerprint(input: CodeProjectEditorSave): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name: input.name ?? null,
        roots: [...new Set(input.roots.map((path) => normalize(path)))],
        primaryRoot: input.primaryRoot ? normalize(input.primaryRoot) : null,
        rootPermissions: Object.entries(input.rootPermissions)
          .map(([path, access]) => [normalize(path), access])
          .sort(([left = ""], [right = ""]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
      }),
    )
    .digest("hex");
}

export function createProjectEditorService(options: {
  repository: ProjectEditorRepository;
  localInstance: LocalInstanceService;
  projects: Pick<ProjectService, "archiveProject">;
  codeUi: Pick<CodeUiService, "hostRpc" | "refreshProjects">;
}): ProjectEditorService {
  async function refresh(actor: LocalActor, projectId: string) {
    try {
      await options.codeUi.refreshProjects(actor, projectId);
    } catch (cause) {
      const error = new CodeUiHostRpcError(
        "project_refresh_failed",
        "项目修改已保存，请刷新项目列表。",
        503,
      );
      error.cause = cause;
      throw error;
    }
  }
  return {
    async readProjects(actor) {
      const context = await options.localInstance.resolve(actor);
      return options.repository.list(context.instanceId);
    },
    async readDirectory(actor, input, context) {
      const requested = input.path || homedir();
      if (!isAbsolute(requested))
        throw new CodeUiHostRpcError(
          "invalid_work_dir",
          "请选择完整的目录路径。",
          400,
        );
      const path = directory(requested);
      const result = await options.codeUi.hostRpc(
        actor,
        "file",
        "readdir",
        [
          {
            path,
            includeHidden: input.includeHidden,
            humanPurpose: "directory-picker",
          },
        ],
        context.connectionId,
      );
      if (!result)
        throw new CodeUiHostRpcError(
          "directory_service_unavailable",
          "目录选择服务不可用，请重新连接工作台。",
          503,
        );
      return codeProjectEditorDirectorySchema.parse({
        path,
        entries: result.result,
      });
    },
    async saveProject(actor, input, signal) {
      const context = await options.localInstance.resolve(actor);
      const result = await options.repository.save(
        context.instanceId,
        input.id,
        input.expectedRevision,
        projectEditFingerprint(input),
        signal,
        (project) => projectChange(project, input),
      );
      await refresh(actor, result.id);
      return result;
    },
    async deleteProject(actor, projectId) {
      await options.projects.archiveProject(actor, projectId);
      await refresh(actor, projectId);
    },
  };
}
