import type { InstanceSettings } from "@kenfutwork/shared";
import type { ExecGit } from "../code-git/git-client.js";
import { resolveReadOnlyProjectPath } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
} from "../persistence/types.js";
import type { ProcessSandbox } from "../process-sandbox/types.js";
import type { CodeUiHostGitSession } from "./host-git-repository.js";
import {
  type CodeUiHostRpcContext,
  CodeUiHostRpcError,
  runCodeUiHostRpc,
} from "./host-rpc-handler.js";
import type { CodeUiHostTarget } from "./host-service-rpc.js";

type ProjectReadRow = SqlRow & {
  work_dir: string;
  additional_directories: Array<{ path: string }>;
  editor_revision: number;
};

export interface CodeUiProjectGitSessions {
  withSession<T>(
    input: {
      actor: LocalActor;
      target: CodeUiHostTarget;
      context: CodeUiHostRpcContext;
      settings: InstanceSettings;
      binary: string;
      available: boolean;
    },
    read: (session: CodeUiHostGitSession) => Promise<T>,
  ): Promise<T>;
}

async function readLockedProject(
  sql: InstanceSqlClient,
  target: CodeUiHostTarget,
) {
  let project: ProjectReadRow | null;
  try {
    project = await sql.queryOne<ProjectReadRow>(
      `select work_dir,additional_directories,editor_revision from public.projects
        where instance_id=:instance and id=$1 and archived_at is null
          and archive_state='open' and enabled_modes && array['code','design']::text[]
        for share nowait`,
      [target.projectId],
    );
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "55P03"
    )
      throw new CodeUiHostRpcError(
        "code_ui_project_conflict",
        "项目正在更新，请稍后刷新文件面板。",
        409,
      );
    throw error;
  }
  if (!project || project.work_dir !== target.rootDirectory)
    throw new CodeUiHostRpcError(
      "code_ui_project_not_found",
      "项目目录已更新，请重新打开文件面板。",
      404,
    );
  return project;
}

function projectGitExec(
  lease:
    | Awaited<ReturnType<ProcessSandbox["openProjectReadLease"]>>
    | undefined,
  signal: AbortSignal,
  binary: string,
  settings: InstanceSettings,
): ExecGit {
  return async (args, cwd, stdin) => {
    signal.throwIfAborted();
    if (!lease) throw new Error("当前环境没有可用Git。");
    const result = await lease.exec({
      argv: { executable: binary, args },
      cwd,
      ...(stdin !== undefined ? { input: stdin } : {}),
      timeoutMs: settings.executeTimeoutMs,
      env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    signal.throwIfAborted();
    if (!result.exit.rangeEmpty)
      throw new Error("Git命令尚未确认退出，不能报告完成。");
    if (result.discardedBytes > 0)
      throw new Error("Git输出超过配置上限，请调整输出限制后重试。");
    return {
      code: result.exit.exitCode ?? 1,
      stdout: result.stdout,
      stderr:
        result.stderr ||
        (result.exit.exitCode !== 0
          ? result.exit.reason || "Git命令执行失败。"
          : ""),
    };
  };
}

/** 项目行锁覆盖完整读取及进程关闭；项目编辑和归档沿同一行更新等待。 */
export function createCodeUiProjectGitSessions(deps: {
  persistence: PersistenceService;
  sandbox: ProcessSandbox;
}): CodeUiProjectGitSessions {
  return {
    async withSession(input, read) {
      const { actor, target, context, settings, binary, available } = input;
      if (
        actor.instanceId !== target.instanceId ||
        context.actor.instanceId !== target.instanceId ||
        target.viewerScope.kind !== "project"
      )
        throw new CodeUiHostRpcError(
          "code_ui_project_not_found",
          "项目读取来源已失效，请重新打开文件面板。",
          404,
        );
      return runCodeUiHostRpc(context, () =>
        deps.persistence.withSessionTransaction(async (tx, databaseSignal) => {
          const signal = AbortSignal.any([context.signal, databaseSignal]);
          signal.throwIfAborted();
          const project = await readLockedProject(
            tx.forInstance(target.instanceId),
            target,
          );
          signal.throwIfAborted();
          const additionalDirectories = project.additional_directories.map(
            (directory) => ({
              path: directory.path,
              access: "read-only" as const,
            }),
          );
          const lease = available
            ? await deps.sandbox.openProjectReadLease(
                {
                  scope: {
                    instanceId: target.instanceId,
                    projectId: target.projectId,
                    connectionId: context.connectionId,
                    revision: String(project.editor_revision),
                    rootDirectory: project.work_dir,
                    additionalDirectories: additionalDirectories.map(
                      (directory) => directory.path,
                    ),
                  },
                  limits: {
                    maxOutputBytes: settings.processMaxOutputBytes,
                    previewMaxChars: settings.processPreviewMaxChars,
                    yieldMs: settings.processYieldMs,
                    killGraceMs: settings.processKillGraceMs,
                  },
                },
                { signal },
              )
            : undefined;
          try {
            signal.throwIfAborted();
            return await read({
              rootDirectory: project.work_dir,
              available,
              limits: settings,
              async resolvePath(path, operation) {
                signal.throwIfAborted();
                if (operation !== "read")
                  throw new CodeUiHostRpcError(
                    "code_ui_path_denied",
                    "项目文件面板仅支持读取，请在任务中修改文件。",
                    403,
                  );
                return resolveReadOnlyProjectPath(
                  {
                    rootDirectory: project.work_dir,
                    additionalDirectories,
                  },
                  path,
                );
              },
              exec: projectGitExec(lease, signal, binary, settings),
            });
          } finally {
            await lease?.close("项目Git读取结束");
          }
        }),
      );
    },
  };
}
