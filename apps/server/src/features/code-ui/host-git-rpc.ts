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
const unavailableMethods = new Set([
  "switchBranch",
  "createBranchAndSwitch",
  "stagePaths",
  "unstagePaths",
  "discardPaths",
  "generateCommitMessage",
  "commit",
  "push",
]);
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
      if (!paths.length) return [];
      const relativePaths = await repo.paths(paths, "read");
      const result = await repo.run(
        ["check-ignore", "-z", "--stdin"],
        `${relativePaths.join("\0")}\0`,
      );
      if (result.code !== 0 && result.code !== 1)
        throw new Error(result.stderr || "Git ignore查询失败。");
      const ignored = new Set(result.stdout.split("\0").filter(Boolean));
      return paths.filter((_path, index) =>
        ignored.has(relativePaths[index] ?? ""),
      );
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
    default:
      throw new Error("不支持的Git只读宿主方法。");
  }
}

/** Task只读Git纵切片；写操作在真实实现获批前明确拒绝，不返回假成功。 */
export function createCodeUiHostGitRpc(deps: {
  resolveTarget(
    actor: LocalActor,
    request: CodeUiHostTargetRequest,
  ): Promise<CodeUiHostTarget>;
  openSession(
    actor: LocalActor,
    target: CodeUiHostTarget,
    operation: "read",
  ): Promise<CodeUiHostGitSession>;
}): CodeUiHostGitRpc {
  return {
    async call(actor, method, args, connection) {
      if (!methods.has(method) && !unavailableMethods.has(method)) return null;
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
      if (target.viewerScope.kind !== "task")
        throw new Error(
          "Git操作需要先创建或选择Code Task；当前Project尚未提供受控进程工作域。",
        );
      if (unavailableMethods.has(method))
        throw new Error(`当前Git宿主尚不支持${method}，该能力仍未接通。`);
      const session = await deps.openSession(actor, target, "read");
      if (session.rootDirectory !== target.rootDirectory)
        throw new Error("Git目标目录与可信Task固定工作目录不匹配。");
      return {
        result: await dispatch(
          new CodeUiHostGitRepository(session),
          method,
          args[0],
        ),
      };
    },
  };
}
