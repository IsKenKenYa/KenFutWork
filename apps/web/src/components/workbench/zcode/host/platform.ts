import {
  type PluginMarketEntry,
  projectPluginPanels,
} from "@kenfutwork/shared";
import type { ApplicationIconInfo, IPlatformService } from "@zcode/shared";
import {
  createCuaPermissionOnboarding,
  localCuaDesktopInvoke,
} from "./cuaPermissionPlatform.js";
import type { CodeHttpChannelClient } from "./httpChannelClient.js";
import { openPluginPanel } from "./parentBridge.js";
import { createWebPlatform } from "./upstream/browserPlatform.js";

/** e58fe8ce宿主能力缝；目录仍经真实Project UUID解析，不建立Canvas或隐式Task。 */
export function createCodePlatform(
  client: CodeHttpChannelClient,
): IPlatformService {
  const desktop = localCuaDesktopInvoke();
  const macDesktop =
    desktop &&
    /Macintosh|Mac OS X/u.test(navigator.userAgent) &&
    !/iPhone|iPad/u.test(navigator.userAgent);
  return {
    ...createWebPlatform(),
    supportsCloudAccounts: false,
    supportsAutomations: false,
    supportsEmbeddedBrowser: false,
    supportsComputerUse: Boolean(macDesktop),
    ...(macDesktop
      ? {
          ...createCuaPermissionOnboarding(desktop),
          executeDesktopCommand: async (command: string) => {
            if (command === "getCuaOsSupport") return { kind: "supported" };
            throw new Error("当前桌面宿主未提供该操作。");
          },
        }
      : {}),
    supportsRemoteWorkspaces: false,
    supportsUserOnboarding: false,
    supportsSettingsImport: false,
    supportsExternalAgentSettingsSync: false,
    supportsAppRuntimePreferences: false,
    sessionMetadataSource: "task-index",
    getApplicationIcon: (request) =>
      client
        .getChannel("platform")
        .call<ApplicationIconInfo | null>("getApplicationIcon", [request]),
    resolvePluginIcon: (resource) => client.resolvePluginIcon(resource),
    skillsSettingsCapabilities: { databaseRecords: true },
    mcpSettingsCapabilities: {
      databaseRecords: true,
      projectScope: false,
      oauth: false,
      httpHeaders: false,
      serverParameters: false,
      sse: false,
    },
    loadMcpFromUserDirectory: (input) =>
      client.services.mcpSyncService.loadMcpFromUserDirectory(input),
    saveMcpToUserDirectory: async (input) => {
      await client.services.mcpSyncService.saveMcpToUserDirectory(input);
      return { success: true };
    },
    migrateLegacyCommonMcp: () => Promise.reject(new Error("旧MCP数据不迁移")),
    pluginSidebar: {
      read: async () =>
        projectPluginPanels(
          (
            await client.request<{ plugins: PluginMarketEntry[] }>(
              "/api/plugins",
            )
          ).plugins,
          "sidebar",
          "code",
        ),
      subscribe: (handler) => {
        const subscription = client.onPluginInventoryChanged(handler);
        return () => subscription.dispose();
      },
      open: (entry) => openPluginPanel(entry.pluginId, entry.entryId),
    },
    async activateOrSetWorkspace(path) {
      const workspace = await client.openWorkspace(
        path,
        client.projectForPath(path)?.projectId,
      );
      const workspaceIdentity = client.workspaces.identityFor(
        workspace.projectId,
        workspace.path,
      );
      return {
        activated: false,
        workspacePath: workspace.path,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      };
    },
    async resolveNewTaskWorkspace(target) {
      await client.refreshWorkspaces();
      const project = client.workspaces.defaultFor(
        target.workspacePath,
        target.taskId,
        target.workspaceIdentity,
      );
      if (!project)
        throw new Error("项目已经不可用，请重新选择 Code 工作目录。");
      const workspaceIdentity = client.workspaces.identityFor(
        project.projectId,
        project.path,
      );
      if (!workspaceIdentity)
        throw new Error("项目目录身份尚未就绪，请重新选择项目。");
      client.workspaces.selectProject(project.projectId);
      return { workspacePath: project.path, workspaceIdentity };
    },
  };
}
