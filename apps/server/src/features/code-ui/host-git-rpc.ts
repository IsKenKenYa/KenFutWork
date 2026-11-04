import { codeUiViewerScopeSchema } from "@kenfutwork/shared";
import type { GitWorkspaceRepositoryInfo } from "@zcode/shared";
import { z } from "zod";
import type { LocalActor } from "../local-instance/types.js";
import {
  CodeUiHostGitRepository,
  type CodeUiHostGitSession,
} from "./host-git-repository.js";
import type {
  CodeUiHostConnection,
  CodeUiHostTarget,
  CodeUiHostTargetRequest,
} from "./host-service-rpc.js";

const targetParams = z.object({
  workspacePath: z.string().min(1),
  workspaceIdentity: z.string().optional(),
  viewerScope: codeUiViewerScopeSchema.optional(),
});
const pathsParams = targetParams.extend({ paths: z.array(z.string().min(1)) });
const methods = new Set([
  "getRepositorySummary",
  "getWorkspaceRepositoryInfo",
  "getLocalBranches",
  "getCommitGraph",
  "getChanges",
  "getIgnoredPaths",
  "getDiff",
  "getBranchComparison",
  "getIdentity",
  "refresh",
]);
const writeMethods = new Set([
  "switchBranch",
  "createBranchAndSwitch",
  "stagePaths",
  "unstagePaths",
  "discardPaths",
  "commit",
  "push",
]);
const unavailableMethods = new Set(["generateCommitMessage"]);
export interface CodeUiHostGitRpc {
  call(
    actor: LocalActor,
    method: string,
    args: unknown[],
    connection: CodeUiHostConnection,
  ): Promise<{ result: unknown } | null>;
}
async function dispatch(
  repo: CodeUiHostGitRepository,
  method: string,
  input: unknown,
): Promise<unknown> {
  switch (method) {
    case "getRepositorySummary":
      return repo.summary();
    case "getWorkspaceRepositoryInfo": {
      const summary = await repo.summary();
      let kind: GitWorkspaceRepositoryInfo["kind"] = "not-repository";
      if (summary.isRepository) {
        const gitDir = await repo.optional(["rev-parse", "--absolute-git-dir"]);
        const common = await repo.optional([
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        kind = gitDir === common ? "main-tree" : "linked-worktree";
      }
      return {
        workspacePath: repo.session.rootDirectory,
        kind,
        isGitAvailable: repo.session.available,
      };
    }
    case "getLocalBranches":
      return repo.localBranches();
    case "getCommitGraph": {
      const params = targetParams
        .extend({
          maxCount: z.number().int().positive().optional(),
          skip: z.number().int().nonnegative().default(0),
        })
        .parse(input);
      return repo.graph(params.maxCount, params.skip);
    }
    case "getChanges":
      return repo.changes(
        targetParams
          .extend({ sourceId: z.enum(["staged", "unstaged"]) })
          .parse(input).sourceId,
      );
    case "getIgnoredPaths": {
      const { paths } = pathsParams.parse(input);
      return repo.ignoredPaths(paths);
    }
    case "getDiff": {
      const params = targetParams
        .extend({
          path: z.string().min(1),
          sourceId: z
            .enum(["staged", "unstaged", "branch", "last-turn"])
            .optional(),
          staged: z.boolean().optional(),
        })
        .parse(input);
      if (params.sourceId === "last-turn")
        throw new Error("上一轮差异必须经真实会话文件变更入口读取。");
      return repo.diff(
        params.path,
        params.sourceId ?? (params.staged ? "staged" : "unstaged"),
      );
    }
    case "getBranchComparison":
      return repo.comparison();
    case "getIdentity":
      return repo.identity();
    case "refresh": {
      const params = targetParams
        .extend({
          includeIdentity: z.boolean().optional(),
          includeBranchComparison: z.boolean().optional(),
        })
        .parse(input);
      return {
        summary: await repo.summary(),
        identity: params.includeIdentity ? await repo.identity() : null,
        unstagedChanges: await repo.changes("unstaged"),
        stagedChanges: await repo.changes("staged"),
        branchComparison: params.includeBranchComparison
          ? await repo.comparison()
          : null,
      };
    }
    case "stagePaths": {
      const { paths } = pathsParams.parse(input);
      await repo.stagePaths(paths);
      return {};
    }
    case "unstagePaths": {
      const { paths } = pathsParams.parse(input);
      await repo.unstagePaths(paths);
      return {};
    }
    case "discardPaths": {
      const params = pathsParams
        .extend({ staged: z.boolean().optional() })
        .parse(input);
      await repo.discardPaths(params.paths, Boolean(params.staged));
      return {};
    }
    case "commit": {
      const params = targetParams
        .extend({
          message: z.string().min(1),
          paths: z.array(z.string().min(1)).optional(),
          stagedOnly: z.boolean().optional(),
        })
        .parse(input);
      return repo.commit(
        params.message,
        params.paths ?? [],
        Boolean(params.stagedOnly),
      );
    }
    case "switchBranch": {
      const { targetBranchName } = targetParams
        .extend({ targetBranchName: z.string().min(1) })
        .parse(input);
      return repo.switchBranch(targetBranchName);
    }
    case "createBranchAndSwitch": {
      const params = targetParams
        .extend({
          branchName: z.string().min(1),
          startPoint: z.string().min(1).optional(),
        })
        .parse(input);
      return repo.createBranchAndSwitch(params.branchName, params.startPoint);
    }
    case "push":
      targetParams.parse(input);
      return repo.push();
    default:
      throw new Error("不支持的Git宿主方法。");
  }
}

/** Git宿主；读取由所属Task或Project的真实执行范围持有，写操作仅在Task作用域开放。 */
export function createCodeUiHostGitRpc(deps: {
  resolveTarget(
    actor: LocalActor,
    request: CodeUiHostTargetRequest,
  ): Promise<CodeUiHostTarget>;
  withSession(
    actor: LocalActor,
    target: CodeUiHostTarget,
    connection: CodeUiHostConnection,
    read: (session: CodeUiHostGitSession) => Promise<unknown>,
  ): Promise<unknown>;
}): CodeUiHostGitRpc {
  return {
    async call(actor, method, args, connection) {
      if (
        !methods.has(method) &&
        !writeMethods.has(method) &&
        !unavailableMethods.has(method)
      )
        return null;
      if (
        !connection.connectionId ||
        connection.instanceId !== actor.instanceId
      )
        throw new Error("Git连接身份不属于当前实例。");
      const target = await deps.resolveTarget(
        actor,
        targetParams.parse(args[0]),
      );
      if (target.instanceId !== connection.instanceId)
        throw new Error("Git工作区与可信连接身份不匹配。");
      if (unavailableMethods.has(method))
        throw new Error(`当前Git宿主尚不支持${method}，该能力仍未接通。`);
      if (writeMethods.has(method) && target.viewerScope.kind === "project")
        throw new Error("项目文件面板仅支持读取，Git写操作请在任务中进行。");
      const result = await deps.withSession(
        actor,
        target,
        connection,
        async (session) => {
          if (session.rootDirectory !== target.rootDirectory)
            throw new Error("Git目标目录与可信来源不匹配。");
          return dispatch(
            new CodeUiHostGitRepository(session),
            method,
            args[0],
          );
        },
      );
      return { result };
    },
  };
}
