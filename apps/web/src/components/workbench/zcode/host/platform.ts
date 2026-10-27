import {
  type ManagementTarget,
  type PluginMarketEntry,
  projectPluginPanels,
} from "@kenfutwork/shared";
import type {
  ApplicationIconInfo,
  HostWorkbenchNavigation,
  IPlatformService,
} from "@zcode/shared";
import {
  createCuaPermissionOnboarding,
  localCuaDesktopInvoke,
} from "./cuaPermissionPlatform.js";
import { createMacDesktopChrome } from "./desktopChrome.js";
import type { CodeHttpChannelClient } from "./httpChannelClient.js";
import { readManagementSettingsTarget } from "./managementNavigation.js";
import { openPluginPanel } from "./parentBridge.js";
import { createWebPlatform } from "./upstream/browserPlatform.js";

/** e58fe8ce宿主能力缝；目录仍经真实Project UUID解析，不建立Canvas或隐式Task。 */
export function createCodePlatform(
  client: CodeHttpChannelClient,
  options: {
    onOpenManagement?: (target: ManagementTarget) => void;
    workbenchNavigation?: HostWorkbenchNavigation;
  } = {},
): IPlatformService {
  const desktop = localCuaDesktopInvoke();
  const macDesktop =
    desktop &&
    /Macintosh|Mac OS X/u.test(navigator.userAgent) &&
    !/iPhone|iPad/u.test(navigator.userAgent);
  return {
    ...createWebPlatform(),
    ...createMacDesktopChrome(),
    ...(desktop
      ? {
          selectDirectory: async () => {
            const selected = await desktop("select_directory");
            if (selected === null || typeof selected === "string")
              return selected;
            throw new Error("系统未返回有效目录，请重新选择。");
          },
          selectDirectories: async () => {
            const selected = await desktop("select_directories");
            if (
              Array.isArray(selected) &&
              selected.every((path) => typeof path === "string")
            )
              return selected;
            throw new Error("系统未返回有效目录，请重新选择。");
          },
        }
      : {}),
    ...(options.workbenchNavigation
      ? {
          workbenchNavigation: options.workbenchNavigation,
          supportsInterfaceModeSettings: false,
        }
      : {}),
    ...(options.onOpenManagement
      ? {
          openSettingsDocument: () =>
            options.onOpenManagement?.(readManagementSettingsTarget()),
          openPluginStoreDocument: (target: {
            pluginId?: string;
            intent?: "add-marketplace";
            returnScopeKey?: string;
          }) =>
            options.onOpenManagement?.({
              ...target,
              page: "plugins",
              returnScopeKey: "user",
            }),
        }
      : {}),
    supportsCloudAccounts: false,
    supportsAutomations: false,
    // T6：宿主有自己的浏览器能力（服务端 browser 工具 + CDP），设置页浏览器分区
    // 经适配层挂这些配置项；工作台侧栏的内置浏览器面板仍由 Root 的显式
    // supportsEmbeddedBrowser={false} 单独关闭（App/Root 只消费自己的 prop）。
    supportsEmbeddedBrowser: true,
    supportsComputerUse: Boolean(macDesktop),
    ...(macDesktop
      ? {
          ...createCuaPermissionOnboarding(desktop, {
            requestPermission: (kind) =>
              client
                .getChannel("cua-permission")
                .call("requestPermission", [{ kind }]),
          }),
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
    pluginManagementCapabilities: {
      sourceInstall: true,
      marketplaceSources: false,
      instanceScope: true,
    },
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
      const workspace = await client.openWorkspace(path);
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
