import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import {
  type CodeUiWorkspace,
  codeUiWorkspaceSchema,
} from "@kenfutwork/shared";
import {
  appSettingsSchema,
  canonicalLocalWorkspaceIdentity,
  type FileEntry,
  parseLocalWorkspaceIdentity,
} from "@zcode/shared";
import { z } from "zod";
import type { LocalActor } from "../local-instance/types.js";
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
type WorkspacePreferenceEntry = z.infer<
  typeof appSettingsSchema
>["lastWorkspaceSession"][number];
type PreferenceOwner = {
  projectId: string;
  rootDirectory: string;
  taskId?: string;
};

function normalizePreferenceTab(
  entry: WorkspacePreferenceEntry,
  owners: Map<string, PreferenceOwner>,
) {
  if (entry.kind !== "local") return null;
  const identity = entry.workspaceIdentity
    ? parseLocalWorkspaceIdentity(entry.workspaceIdentity, entry.workspacePath)
    : null;
  if (entry.workspaceIdentity && !identity) return null;
  const key = identity
    ? canonicalLocalWorkspaceIdentity(
        identity.projectId,
        identity.rootDirectory,
      )
    : entry.workspacePath;
  const owner = owners.get(key);
  if (!owner || owner.rootDirectory !== entry.workspacePath) return null;
  return {
    ...entry,
    workspaceIdentity: canonicalLocalWorkspaceIdentity(
      owner.projectId,
      owner.rootDirectory,
    ),
  };
}

function normalizePreferenceFocus(
  focus: Record<string, string>,
  owners: Map<string, PreferenceOwner>,
) {
  const normalized: Record<string, string> = {};
  for (const [key, taskId] of Object.entries(focus)) {
    const owner = owners.get(key);
    if (!owner || owner.taskId !== taskId) continue;
    normalized[
      canonicalLocalWorkspaceIdentity(owner.projectId, owner.rootDirectory)
    ] = taskId;
  }
  return normalized;
}

type TaskPreference = {
  key: string;
  taskId: string;
  owner:
    | Pick<PreferenceOwner, "projectId" | "rootDirectory">
    | null
    | undefined;
};

function applyPreferenceFocus(
  owners: Map<string, PreferenceOwner>,
  tasks: readonly TaskPreference[],
  projectIds: ReadonlySet<string>,
) {
  const focusedPaths = new Map<string, Map<string, PreferenceOwner>>();
  const invalidPaths = new Set<string>();
  const legacyFocus = new Map<string, PreferenceOwner>();
  for (const { key, taskId, owner } of tasks) {
    const identity = parseLocalWorkspaceIdentity(key);
    const rootDirectory = identity?.rootDirectory ?? key;
    if (
      !owner ||
      owner.rootDirectory !== rootDirectory ||
      (identity && owner.projectId !== identity.projectId) ||
      !projectIds.has(owner.projectId)
    ) {
      // 显式Task焦点失效不能悄悄转给碰巧拥有同路径的另一Project。
      owners.delete(key);
      owners.delete(rootDirectory);
      invalidPaths.add(rootDirectory);
      if (identity)
        owners.delete(
          canonicalLocalWorkspaceIdentity(
            identity.projectId,
            identity.rootDirectory,
          ),
        );
    } else {
      const focused = { ...owner, taskId };
      const qualified = canonicalLocalWorkspaceIdentity(
        owner.projectId,
        owner.rootDirectory,
      );
      owners.set(key, focused);
      owners.set(qualified, focused);
      const scopes =
        focusedPaths.get(rootDirectory) ?? new Map<string, PreferenceOwner>();
      scopes.set(qualified, focused);
      focusedPaths.set(rootDirectory, scopes);
      if (!identity) legacyFocus.set(rootDirectory, focused);
    }
  }
  for (const [path, scopes] of focusedPaths) {
    const explicit = legacyFocus.get(path);
    if (explicit) {
      owners.set(path, explicit);
    } else if (invalidPaths.has(path) || scopes.size !== 1) {
      owners.delete(path);
    } else {
      for (const owner of scopes.values()) owners.set(path, owner);
    }
  }
}

export interface HumanWorkspaceRpc {
  call(
    actor: LocalActor,
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
  instanceId: (actor: LocalActor) => Promise<string>;
  listWorkspaces: (actor: LocalActor) => Promise<CodeUiWorkspace[]>;
  resolveTaskPreference?: (
    actor: LocalActor,
    taskId: string,
  ) => Promise<{ projectId: string; rootDirectory: string } | null>;
  maxEntries: (actor: LocalActor) => Promise<number>;
}): HumanWorkspaceRpc {
  const opening = new Map<string, Promise<CodeUiWorkspace>>();
  const conversationOpening = new Map<string, Promise<ConversationWorkspace>>();
  const ensureConversationWorkspace = async (actor: LocalActor) => {
    const instanceId = await options.instanceId(actor);
    const current = conversationOpening.get(instanceId);
    if (current) return current;
    const ensuring = (async (): Promise<ConversationWorkspace> => {
      const preferences =
        await options.preferences.readHumanPreferences(instanceId);
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
        instanceId,
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
    conversationOpening.set(instanceId, ensuring);
    try {
      return await ensuring;
    } finally {
      if (conversationOpening.get(instanceId) === ensuring)
        conversationOpening.delete(instanceId);
    }
  };
  const preferenceOwners = async (
    actor: LocalActor,
    workspaces: CodeUiWorkspace[],
    focus: Record<string, string> | undefined,
  ) => {
    const owners = new Map<string, PreferenceOwner>();
    const ambiguous = new Set<string>();
    const projectIds = new Set(workspaces.map((project) => project.projectId));
    for (const project of workspaces) {
      const owner = {
        projectId: project.projectId,
        rootDirectory: project.path,
      };
      owners.set(
        canonicalLocalWorkspaceIdentity(project.projectId, project.path),
        owner,
      );
      if (owners.has(project.path)) {
        owners.delete(project.path);
        ambiguous.add(project.path);
      } else if (!ambiguous.has(project.path)) {
        owners.set(project.path, owner);
      }
    }
    const tasks = await Promise.all(
      Object.entries(focus ?? {}).map(async ([key, taskId]) => ({
        key,
        taskId,
        owner: z.uuid().safeParse(taskId).success
          ? await options.resolveTaskPreference?.(actor, taskId)
          : null,
      })),
    );
    applyPreferenceFocus(owners, tasks, projectIds);
    return owners;
  };
  const openProject = async (
    actor: LocalActor,
    inputPath: string,
    projectId?: string,
  ): Promise<CodeUiWorkspace> => {
    if (!isAbsolute(inputPath))
      throw new CodeUiRepositoryError("not_found", "请选择绝对目录路径。");
    const path = await realpath(inputPath);
    if (!(await stat(path)).isDirectory())
      throw new CodeUiRepositoryError("not_found", "选中的路径不是目录。");
    const instanceId = await options.instanceId(actor);
    const key = `${instanceId}:${projectId ?? ""}:${path}`;
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
    actor: LocalActor,
  ): Promise<z.infer<typeof appSettingsSchema>> => {
    const [workspaces, stored] = await Promise.all([
      options.listWorkspaces(actor),
      options.preferences.readHumanPreferences(await options.instanceId(actor)),
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
      ).filter((path) => owners.get(path)?.rootDirectory === path),
    );
    const activeIndex = settings.lastActiveTabIndex;
    const tabs = settings.lastWorkspaceSession.flatMap((entry, index) => {
      const normalized = normalizePreferenceTab(entry, owners);
      return normalized ? [{ entry: normalized, index }] : [];
    });
    settings.lastWorkspaceSession = tabs.map((tab) => tab.entry);
    settings.lastActiveTabIndex = Math.max(
      tabs.findIndex((tab) => tab.index === activeIndex),
      0,
    );
    if (settings.lastActiveTaskByWorkspace)
      settings.lastActiveTaskByWorkspace = normalizePreferenceFocus(
        settings.lastActiveTaskByWorkspace,
        owners,
      );
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
              await options.instanceId(actor),
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
        const workspaces = await options.listWorkspaces(actor);
        const owners = await preferenceOwners(
          actor,
          workspaces,
          parsed.lastActiveTaskByWorkspace,
        );
        const referencedKeys: string[] = [];
        if ("recentProjects" in normalized) {
          for (const path of parsed.recentProjects) {
            if (owners.get(path)?.rootDirectory !== path)
              throw new CodeUiRepositoryError(
                "not_found",
                "设置中的工作目录不属于当前工作区或已归档。",
              );
            referencedKeys.push(path);
          }
        }
        if ("lastWorkspaceSession" in normalized) {
          normalized.lastWorkspaceSession = parsed.lastWorkspaceSession.map(
            (entry) => {
              if (entry.kind !== "local")
                throw new CodeUiRepositoryError(
                  "not_found",
                  "当前 Code 宿主尚未接通远程工作区。",
                );
              const tab = normalizePreferenceTab(entry, owners);
              if (!tab)
                throw new CodeUiRepositoryError(
                  "not_found",
                  "设置中的工作目录不属于当前工作区或已归档。",
                );
              referencedKeys.push(tab.workspaceIdentity);
              return tab;
            },
          );
        }
        if ("lastActiveTaskByWorkspace" in normalized) {
          const focus = parsed.lastActiveTaskByWorkspace ?? {};
          for (const [key, taskId] of Object.entries(focus)) {
            if (owners.get(key)?.taskId !== taskId)
              throw new CodeUiRepositoryError(
                "not_found",
                "设置中的工作目录不属于当前工作区或已归档。",
              );
            referencedKeys.push(key);
          }
          normalized.lastActiveTaskByWorkspace = normalizePreferenceFocus(
            focus,
            owners,
          );
        }
        if ("recentProjects" in normalized)
          normalized.recentProjects = normalizeRecentProjects(
            parsed.recentProjects,
          );
        const saved = await options.preferences.updateHumanPreferences(
          await options.instanceId(actor),
          normalized,
          {
            referencedProjectIds: referencedKeys.flatMap((key) => {
              const owner = owners.get(key);
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
