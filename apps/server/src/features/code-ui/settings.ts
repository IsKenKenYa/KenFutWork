import type { CodeUiWorkspace } from "@kenfutwork/shared";
import { appSettingsPatchSchema, appSettingsSchema } from "@zcode/shared";
import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import type { SettingsService } from "../settings/settings-service.js";
import { CodeUiRepositoryError } from "./repository.js";

// 固定原 settingService.ts 的 UI 最近项目条目数；非 Agent 运行限额。
const MAX_RECENT_PROJECTS = 10;

/** 原 ISettingService 的真实存储适配，不维护另一份 UI 设置契约。 */
export class CodeUiSettingsHost {
  constructor(
    private readonly deps: {
      settings: SettingsService;
      viewer: ViewerService;
      workspaces: (user: AuthenticatedUser) => Promise<CodeUiWorkspace[]>;
    },
  ) {}

  async call(user: AuthenticatedUser, method: string, value: unknown) {
    if (method !== "get" && method !== "update") return null;
    const workspace = await this.deps.viewer.resolveWorkspace(user);
    const projects = await this.deps.workspaces(user);
    const available = new Set(projects.map((project) => project.path));
    return method === "get"
      ? this.read(user, workspace.id, available)
      : this.update(user, workspace.id, projects, available, value);
  }

  private async read(
    user: AuthenticatedUser,
    workspaceId: string,
    available: Set<string>,
  ) {
    const { preferences: raw, recentProjects: recent } =
      await this.deps.settings.getCodeUiSettingsSnapshot(user, workspaceId);
    const saved = appSettingsPatchSchema
      .omit({ recentProjects: true })
      .strict()
      .parse(raw ?? {});
    const entries = saved.lastWorkspaceSession ?? [];
    const active = entries[saved.lastActiveTabIndex ?? 0];
    const tabs = entries.filter(
      (entry) => entry.kind === "local" && available.has(entry.workspacePath),
    );
    const activeIndex = active ? tabs.indexOf(active) : -1;
    const result = appSettingsSchema.parse({
      ...appSettingsSchema.parse({}),
      ...saved,
      recentProjects: [
        ...new Set(
          (recent ?? [...available]).filter((path) => available.has(path)),
        ),
      ].slice(0, MAX_RECENT_PROJECTS),
      lastWorkspaceSession: tabs,
      lastActiveTabIndex: Math.max(activeIndex, 0),
      ...(saved.lastActiveTaskByWorkspace
        ? {
            lastActiveTaskByWorkspace: Object.fromEntries(
              Object.entries(saved.lastActiveTaskByWorkspace).filter(([path]) =>
                available.has(path),
              ),
            ),
          }
        : {}),
    });
    return { result };
  }

  private async update(
    user: AuthenticatedUser,
    workspaceId: string,
    projects: CodeUiWorkspace[],
    available: Set<string>,
    value: unknown,
  ) {
    const input = appSettingsPatchSchema.strict().parse(value);
    const paths = [
      ...(input.recentProjects ?? []),
      ...(input.lastWorkspaceSession ?? []).map((entry) => {
        if (entry.kind !== "local")
          throw new CodeUiRepositoryError(
            "not_found",
            "当前 Code 宿主尚未接通远程工作区",
          );
        return entry.workspacePath;
      }),
      ...Object.keys(input.lastActiveTaskByWorkspace ?? {}),
    ];
    if (paths.some((path) => !available.has(path)))
      throw new CodeUiRepositoryError(
        "not_found",
        "设置中的工作目录不属于当前工作区或已归档",
      );
    const { recentProjects: requestedRecentProjects, ...patch } = input;
    const recentProjects = requestedRecentProjects
      ? [...new Set(requestedRecentProjects)].slice(0, MAX_RECENT_PROJECTS)
      : undefined;
    const deletedKeys: string[] = [];
    if (patch.providerFamilyDomain === "") {
      delete patch.providerFamilyDomain;
      deletedKeys.push("providerFamilyDomain");
    }
    const saved = await this.deps.settings.updateCodeUiAppPreferences(
      user,
      workspaceId,
      {
        preferences: patch,
        ...(recentProjects ? { recentProjects } : {}),
        removePreferenceKeys: deletedKeys,
        referencedProjectIds: [
          ...new Set(
            projects
              .filter((project) => paths.includes(project.path))
              .map((project) => project.projectId),
          ),
        ],
      },
    );
    if (!saved)
      throw new CodeUiRepositoryError(
        "not_found",
        "设置中的 Code 项目已归档，偏好未保存",
      );
    return { result: null };
  }
}
