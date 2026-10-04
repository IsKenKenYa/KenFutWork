import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import {
  type CodeUiWorkspace,
  codeUiWorkspaceSchema,
} from "@kenfutwork/shared";
import { appSettingsSchema, type FileEntry } from "@zcode/shared";
import { z } from "zod";
import type { AuthenticatedUser } from "../auth/types.js";
import type { ProjectService } from "../projects/project-service.js";
import { validateWorkDir } from "../projects/work-dir.js";
import type { CodeUiRepository } from "./repository.js";
import { CodeUiRepositoryError } from "./repository.js";

const directoryParams = z.object({
  path: z.string().min(1),
  includeHidden: z.boolean().optional(),
  humanPurpose: z.literal("directory-picker"),
});
// 原 UI 最近项目历史固定展示前10项，不是 Agent 运行时限额。
const CODE_UI_RECENT_PROJECT_LIMIT = 10;

function normalizeRecentProjects(paths: readonly string[]): string[] {
  return [...new Set(paths)].slice(0, CODE_UI_RECENT_PROJECT_LIMIT);
}

function canonicalWorkspace(project: CodeUiWorkspace): CodeUiWorkspace {
  const root = validateWorkDir(project.path);
  if (!root.ok)
    throw new CodeUiRepositoryError(
      "not_found",
      `Code 项目目录不可用：${root.reason}`,
    );
  return codeUiWorkspaceSchema.parse({ ...project, path: root.path });
}

type ConversationWorkspace = CodeUiWorkspace & {
  created: boolean;
  workspacePurpose: "conversation";
};
const preferenceKeys = new Set([
  "recentProjects",
  "locale",
  "localePreference",
  "shortcutBindings",
  "messageStreamShowReasoning",
  "messageStreamShowReasoningMigrationInitialized",
  "messageStreamShowTodos",
  "toolGroupingExploreEnabled",
  "toolGroupingTerminalEnabled",
  "toolGroupingChangesEnabled",
  "zcodeInteractionBehavior",
  "lastWorkspaceSession",
  "lastActiveTabIndex",
  "lastActiveTaskByWorkspace",
  "startPlanRecommendationDismissed",
  "onboardingOccupation",
  "terminalFontFamily",
  "terminalInheritSystemProfile",
]);
export interface HumanWorkspaceRpc {
  call(
    actor: AuthenticatedUser,
    service: string,
    method: string,
    args: unknown[],
  ): Promise<{ result: unknown } | null>;
}

/** 人工目录选择只返回元数据。没有 Task 权限签发，也没有模型工具注册。 */
export function createHumanWorkspaceRpc(options: {
  projects: ProjectService;
  preferences: Pick<
    CodeUiRepository,
    "readHumanPreferences" | "updateHumanPreferences"
  >;
  workspaceId: (actor: AuthenticatedUser) => Promise<string>;
  listWorkspaces: (actor: AuthenticatedUser) => Promise<CodeUiWorkspace[]>;
  resolveTaskPreference?: (
    actor: AuthenticatedUser,
    taskId: string,
  ) => Promise<{ projectId: string; rootDirectory: string } | null>;
  maxEntries: (actor: AuthenticatedUser) => Promise<number>;
}): HumanWorkspaceRpc {
  const opening = new Map<string, Promise<CodeUiWorkspace>>();
  const conversationOpening = new Map<string, Promise<ConversationWorkspace>>();
  const ensureConversationWorkspace = async (actor: AuthenticatedUser) => {
    const workspaceId = await options.workspaceId(actor);
    const current = conversationOpening.get(workspaceId);
    if (current) return current;
    const ensuring = (async (): Promise<ConversationWorkspace> => {
      const preferences =
        await options.preferences.readHumanPreferences(workspaceId);
      const savedId = preferences.defaultConversationProjectId;
      const existing = (await options.listWorkspaces(actor)).find(
        (project) => project.projectId === savedId,
      );
      if (existing)
        return {
          ...canonicalWorkspace(existing),
          created: false,
          workspacePurpose: "conversation",
        };
      const created = await options.projects.createProject(actor, {
        kind: "code",
        name: "默认对话",
      });
      if (created.kind !== "code")
        throw new CodeUiRepositoryError(
          "command_conflict",
          "默认对话项目创建类型不匹配。",
        );
      const project = canonicalWorkspace({
        projectId: created.id,
        name: created.name,
        path: created.workDir,
        additionalDirectories: created.additionalDirectories,
      });
      const saved = await options.preferences.updateHumanPreferences(
        workspaceId,
        { defaultConversationProjectId: project.projectId },
        { referencedProjectIds: [project.projectId] },
      );
      if (!saved)
        throw new CodeUiRepositoryError(
          "not_found",
          "默认对话项目已归档，工作区引用未保存。",
        );
      return { ...project, created: true, workspacePurpose: "conversation" };
    })();
    conversationOpening.set(workspaceId, ensuring);
    try {
      return await ensuring;
    } finally {
      if (conversationOpening.get(workspaceId) === ensuring)
        conversationOpening.delete(workspaceId);
    }
  };
  const preferenceOwners = async (
    actor: AuthenticatedUser,
    workspaces: CodeUiWorkspace[],
    focus: Record<string, string> | undefined,
  ) => {
    const owners = new Map<string, { projectId: string; taskId?: string }>();
    const ambiguous = new Set<string>();
    const projectIds = new Set(workspaces.map((project) => project.projectId));
    for (const project of workspaces) {
      if (owners.has(project.path)) {
        owners.delete(project.path);
        ambiguous.add(project.path);
      } else if (!ambiguous.has(project.path)) {
        owners.set(project.path, { projectId: project.projectId });
      }
    }
    const tasks = await Promise.all(
      Object.entries(focus ?? {}).map(async ([path, taskId]) => ({
        path,
        taskId,
        owner: z.uuid().safeParse(taskId).success
          ? await options.resolveTaskPreference?.(actor, taskId)
          : null,
      })),
    );
    for (const { path, taskId, owner } of tasks) {
      if (
        !owner ||
        owner.rootDirectory !== path ||
        !projectIds.has(owner.projectId)
      ) {
        // 显式Task焦点失效不能悄悄转给碰巧拥有同路径的另一Project。
        owners.delete(path);
      } else {
        owners.set(path, { projectId: owner.projectId, taskId });
      }
    }
    return owners;
  };
  const openProject = async (
    actor: AuthenticatedUser,
    inputPath: string,
    projectId?: string,
  ): Promise<CodeUiWorkspace> => {
    if (!isAbsolute(inputPath))
      throw new CodeUiRepositoryError("not_found", "请选择绝对目录路径。");
    const path = await realpath(inputPath);
    if (!(await stat(path)).isDirectory())
      throw new CodeUiRepositoryError("not_found", "选中的路径不是目录。");
    const workspaceId = await options.workspaceId(actor);
    const key = `${workspaceId}:${projectId ?? ""}:${path}`;
    const existing = opening.get(key);
    if (existing) return existing;
    const openingProject = (async () => {
      const projects = await options.listWorkspaces(actor);
      if (projectId) {
        const project = projects.find(
          (entry) => entry.projectId === projectId && entry.path === path,
        );
        if (!project)
          throw new CodeUiRepositoryError(
            "not_found",
            "选择的 Code 项目与默认目录不匹配。",
          );
        return project;
      }
      const matches = projects.filter((entry) => entry.path === path);
      if (matches.length > 1)
        throw new CodeUiRepositoryError(
          "command_conflict",
          "多个 Code 项目共享此目录，请明确选择项目。",
        );
      if (matches[0]) return matches[0];
      const created = await options.projects.createProject(actor, {
        kind: "code",
        name: basename(path) || path,
        work_dir: path,
      });
      if (created.kind !== "code")
        throw new CodeUiRepositoryError(
          "command_conflict",
          "Code 项目创建返回了错误类型。",
        );
      return {
        projectId: created.id,
        name: created.name,
        path: created.workDir,
        additionalDirectories: created.additionalDirectories,
      };
    })();
    opening.set(key, openingProject);
    try {
      return await openingProject;
    } finally {
      if (opening.get(key) === openingProject) opening.delete(key);
    }
  };
  const settingsFor = async (
    actor: AuthenticatedUser,
  ): Promise<z.infer<typeof appSettingsSchema>> => {
    const [workspaces, stored] = await Promise.all([
      options.listWorkspaces(actor),
      options.preferences.readHumanPreferences(
        await options.workspaceId(actor),
      ),
    ]);
    const settings = appSettingsSchema.parse(stored);
    const owners = await preferenceOwners(
      actor,
      workspaces,
      settings.lastActiveTaskByWorkspace,
    );
    settings.recentProjects = normalizeRecentProjects(
      (stored.recentProjects === undefined
        ? workspaces.map((project) => project.path)
        : settings.recentProjects
      ).filter((path) => owners.has(path)),
    );
    const active = settings.lastWorkspaceSession[settings.lastActiveTabIndex];
    settings.lastWorkspaceSession = settings.lastWorkspaceSession.filter(
      (entry) => entry.kind === "local" && owners.has(entry.workspacePath),
    );
    settings.lastActiveTabIndex = Math.max(
      active ? settings.lastWorkspaceSession.indexOf(active) : -1,
      0,
    );
    if (settings.lastActiveTaskByWorkspace) {
      settings.lastActiveTaskByWorkspace = Object.fromEntries(
        Object.entries(settings.lastActiveTaskByWorkspace).filter(
          ([path, taskId]) => owners.get(path)?.taskId === taskId,
        ),
      );
    }
    return settings;
  };
  return {
    async call(actor, service, method, args) {
      if (service === "file" && method === "ensureConversationWorkspace")
        return { result: await ensureConversationWorkspace(actor) };
      if (service === "workspace" && method === "open") {
        const params = z
          .object({ path: z.string().min(1), projectId: z.uuid().optional() })
          .parse(args[0]);
        return {
          result: await openProject(actor, params.path, params.projectId),
        };
      }
      if (
        service === "file" &&
        method === "readdir" &&
        args[0] &&
        typeof args[0] === "object" &&
        "humanPurpose" in args[0]
      ) {
        const params = directoryParams.parse(args[0]);
        if (!isAbsolute(params.path))
          throw new CodeUiRepositoryError(
            "not_found",
            "目录选择器只接受绝对路径。",
          );
        const path = await realpath(params.path);
        const maxEntries = await options.maxEntries(actor);
        const entries: FileEntry[] = [];
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (!params.includeHidden && entry.name.startsWith(".")) continue;
          const child = join(path, entry.name);
          const linked = entry.isSymbolicLink();
          const isDirectory =
            entry.isDirectory() ||
            (linked && (await stat(child).catch(() => null))?.isDirectory());
          if (!isDirectory) continue;
          entries.push({
            name: entry.name,
            path: child,
            type: "directory",
            ...(linked ? { isSymbolicLink: true } : {}),
          });
          if (entries.length > maxEntries)
            throw new CodeUiRepositoryError(
              "command_conflict",
              "目录条目超过工作区配置上限，请输入更具体的目录。",
            );
        }
        return { result: entries.sort((a, b) => a.name.localeCompare(b.name)) };
      }
      if (
        service === "file" &&
        (method === "createDefaultWorkspace" ||
          method === "createScratchWorkspace")
      ) {
        const name =
          method === "createScratchWorkspace"
            ? z.object({ name: z.string().trim().min(1) }).parse(args[0]).name
            : "新建 Code 项目";
        const project = await options.projects.createProject(actor, {
          kind: "code",
          name,
        });
        if (project.kind !== "code")
          throw new CodeUiRepositoryError(
            "command_conflict",
            "Code 项目创建类型不匹配。",
          );
        return {
          result: canonicalWorkspace({
            projectId: project.id,
            name: project.name,
            path: project.workDir,
            additionalDirectories: project.additionalDirectories,
          }),
        };
      }
      if (service === "setting" && method === "get")
        return { result: await settingsFor(actor) };
      if (service === "setting" && method === "update") {
        const patch = z.record(z.string(), z.unknown()).parse(args[0]);
        const unsupported = Object.keys(patch).find(
          (key) => !preferenceKeys.has(key),
        );
        if (unsupported)
          throw new CodeUiRepositoryError(
            "command_conflict",
            `当前宿主尚不支持设置：${unsupported}`,
          );
        const parsed = appSettingsSchema.parse({
          ...appSettingsSchema.parse(
            await options.preferences.readHumanPreferences(
              await options.workspaceId(actor),
            ),
          ),
          ...patch,
        });
        const normalized = Object.fromEntries(
          Object.keys(patch).map((key) => [
            key,
            parsed[key as keyof typeof parsed],
          ]),
        );
        if ("messageStreamShowReasoning" in patch)
          normalized.messageStreamShowReasoningMigrationInitialized =
            parsed.messageStreamShowReasoningMigrationInitialized;
        if ("locale" in patch && !("localePreference" in patch))
          normalized.localePreference = parsed.locale;
        const referencedPaths = [
          ...("recentProjects" in normalized ? parsed.recentProjects : []),
          ...("lastWorkspaceSession" in normalized
            ? parsed.lastWorkspaceSession.map((entry) => {
                if (entry.kind !== "local")
                  throw new CodeUiRepositoryError(
                    "not_found",
                    "当前 Code 宿主尚未接通远程工作区。",
                  );
                return entry.workspacePath;
              })
            : []),
          ...Object.keys(
            "lastActiveTaskByWorkspace" in normalized
              ? (parsed.lastActiveTaskByWorkspace ?? {})
              : {},
          ),
        ];
        const workspaces = await options.listWorkspaces(actor);
        const owners = await preferenceOwners(
          actor,
          workspaces,
          parsed.lastActiveTaskByWorkspace,
        );
        if (referencedPaths.some((path) => !owners.has(path)))
          throw new CodeUiRepositoryError(
            "not_found",
            "设置中的工作目录不属于当前工作区或已归档。",
          );
        if ("recentProjects" in normalized)
          normalized.recentProjects = normalizeRecentProjects(
            parsed.recentProjects,
          );
        const saved = await options.preferences.updateHumanPreferences(
          await options.workspaceId(actor),
          normalized,
          {
            referencedProjectIds: referencedPaths.flatMap((path) => {
              const owner = owners.get(path);
              return owner ? [owner.projectId] : [];
            }),
          },
        );
        if (!saved)
          throw new CodeUiRepositoryError(
            "not_found",
            "设置中的 Code 项目已归档，偏好未保存。",
          );
        return { result: undefined };
      }
      return null;
    },
  };
}
