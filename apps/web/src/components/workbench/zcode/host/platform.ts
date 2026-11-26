import {
  type MarketplaceSearchResponse,
  type ManagementTarget,
  type PluginMarketEntry,
  projectPluginPanels,
} from "@kenfutwork/shared";
import type {
  ApplicationIconInfo,
  HostMcpCatalogItem,
  HostMcpMarketplaceItem,
  HostSkillImportSource,
  HostSkillMarketplaceSearchResult,
  HostWorkbenchNavigation,
  IPlatformService,
} from "@zcode/shared";
import {
  createCuaPermissionOnboarding,
  localCuaDesktopInvoke,
} from "./cuaPermissionPlatform.js";
import { createMacDesktopChrome } from "./desktopChrome.js";
import { CodeHostHttpError, type CodeHttpChannelClient } from "./httpChannelClient.js";
import { readManagementSettingsTarget } from "./managementNavigation.js";
import { openPluginPanel } from "./parentBridge.js";
import { createWebPlatform } from "./upstream/browserPlatform.js";

/** 宿主管理入口带显式目标；`IPlatformService` 的声明保持无参兼容。 */
export type CodePlatform = IPlatformService & {
  openSettingsDocument?: (target?: ManagementTarget) => void;
};

interface HostSkillImportSourceResponse {
  source: HostSkillImportSource;
}

interface HostMcpRegistrySearchResponse {
  servers: Array<
    Pick<
      HostMcpMarketplaceItem,
      | "name"
      | "description"
      | "version"
      | "kind"
      | "installable"
      | "unsupportedReason"
      | "suggestedCommand"
      | "suggestedArgs"
      | "suggestedUrl"
      | "suggestedName"
    >
  >;
}

interface HostMcpCatalogResponse {
  servers: ReadonlyArray<{
    id: string;
    name: string;
    title: string;
    description: string;
    command: string;
    argsTemplate: readonly string[];
    params: HostMcpCatalogItem["params"];
    requires: "node" | "python";
  }>;
}

/** e58fe8ce宿主能力缝；目录仍经真实Project UUID解析，不建立Canvas或隐式Task。 */
export function createCodePlatform(
  client: CodeHttpChannelClient,
  options: {
    onOpenManagement?: (target: ManagementTarget) => void;
    workbenchNavigation?: HostWorkbenchNavigation;
    selectDirectory?: IPlatformService["selectDirectory"];
    /**
     * 壳内当前主区模式（Design/Flow 是 Code 壳内的视图）：插件侧栏按真实
     * surface 过滤，而不是把 mode 硬编码成 "code"（scope=shared 本就不受过滤）。
     */
    surfaceMode?: () => "code" | "design" | "flow";
  } = {},
): CodePlatform {
  const desktop = localCuaDesktopInvoke();
  const macDesktop =
    desktop &&
    /Macintosh|Mac OS X/u.test(navigator.userAgent) &&
    !/iPhone|iPad/u.test(navigator.userAgent);
  return {
    ...createWebPlatform(),
    ...createMacDesktopChrome(),
    ...(options.selectDirectory
      ? { selectDirectory: options.selectDirectory }
      : {}),
    ...(options.workbenchNavigation
      ? {
          workbenchNavigation: options.workbenchNavigation,
          supportsInterfaceModeSettings: false,
        }
      : {}),
    ...(options.onOpenManagement
      ? {
          // 入口带目标时直接转发；只有无目标的老调用才回读共享 sessionStorage 意图。
          openSettingsDocument: (target?: ManagementTarget) =>
            options.onOpenManagement?.(
              target ?? readManagementSettingsTarget(),
            ),
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
    // 技能导入已接通：外部 Agent 目录扫描 + 暂存来源（git 仓库 / zip 包）走服务端宿主 RPC。
    supportsExternalAgentSettingsSync: true,
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
    // 技能市场：接本机服务的搜索与安装接口。只把界面用得到的字段交给上层，
    // 接口里的 downloads 是用 npm 热度分数折算出来的，不是真实下载量，不外传。
    skillMarketplace: {
      search: async ({ query, page, limit }) => {
        const result = await client.request<MarketplaceSearchResponse>(
          `/api/skills/marketplace/search?${new URLSearchParams({
            q: query,
            page: String(page),
            limit: String(limit),
          })}`,
        );
        return {
          total: result.total,
          skills: result.skills.map(
            ({ packageName, name, description, author, version, keywords, homepage, repository, license }) => ({
              packageName,
              name,
              description,
              author,
              version,
              keywords,
              ...(homepage ? { homepage } : {}),
              ...(repository ? { repository } : {}),
              ...(license ? { license } : {}),
            }),
          ),
        } satisfies HostSkillMarketplaceSearchResult;
      },
      install: async ({ packageName }) => {
        try {
          await client.request("/api/skills/marketplace/install", { packageName });
        } catch (error) {
          // 服务端对重复安装回 409：这是「此前已添加过」，界面据此标成已添加
          if (error instanceof CodeHostHttpError && error.status === 409) {
            return { status: "alreadyInstalled" as const };
          }
          throw error;
        }
        return { status: "added" as const };
      },
    },
    // 技能导入来源：git 仓库与 zip 包先暂存到服务端本机目录，导入对话框再从中挑选。
    // 暂存的保留时长与数量上限由实例设置约束，对话框关闭时界面会主动释放。
    skillImportSources: {
      stageGit: async ({ url }) => {
        const result = await client.request<HostSkillImportSourceResponse>(
          "/api/skills/import-sources/git",
          { url },
        );
        return result.source;
      },
      stageZip: async ({ file }) => {
        const form = new FormData();
        form.append("file", file, file.name);
        const result = await client.postMultipart<HostSkillImportSourceResponse>(
          "/api/skills/import-sources/zip",
          form,
        );
        return result.source;
      },
      release: async ({ id }) => {
        try {
          await client.deleteRequest(`/api/skills/import-sources/${id}`);
          return true;
        } catch (error) {
          // 404 = 来源已释放或已过期，对界面来说就是「没有这个来源」
          if (error instanceof CodeHostHttpError && error.status === 404) {
            return false;
          }
          throw error;
        }
      },
    },
    // MCP 市场：官方注册表检索 + 内置精选目录，一键添加走服务端 MCP server 管理接口。
    mcpMarketplace: {
      search: async ({ query, limit }) => {
        const result = await client.request<HostMcpRegistrySearchResponse>(
          `/api/mcp/registry?${new URLSearchParams({
            q: query,
            limit: String(limit),
          })}`,
        );
        return {
          items: result.servers.map((server) => ({
            name: server.name,
            description: server.description,
            version: server.version,
            kind: server.kind,
            installable: server.installable,
            unsupportedReason: server.unsupportedReason,
            suggestedCommand: server.suggestedCommand,
            suggestedArgs: server.suggestedArgs,
            suggestedUrl: server.suggestedUrl,
            suggestedName: server.suggestedName,
          })),
        };
      },
      catalog: async () => {
        const result = await client.request<HostMcpCatalogResponse>(
          "/api/mcp/catalog",
        );
        return result.servers.map((server) => ({
          id: server.id,
          name: server.name,
          title: server.title,
          description: server.description,
          command: server.command,
          argsTemplate: server.argsTemplate,
          params: server.params,
          requires: server.requires,
        })) satisfies HostMcpCatalogItem[];
      },
      add: async ({ name, kind, command, args, url }) => {
        try {
          await client.request("/api/mcp/servers", {
            name,
            kind,
            ...(kind === "stdio"
              ? { command, args: args ?? [] }
              : { url }),
          });
        } catch (error) {
          // 服务端对同名 server 回 409：这是「此前已添加过」
          if (error instanceof CodeHostHttpError && error.status === 409) {
            return { status: "alreadyInstalled" as const };
          }
          throw error;
        }
        return { status: "added" as const };
      },
    },
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
          options.surfaceMode?.() ?? "code",
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
