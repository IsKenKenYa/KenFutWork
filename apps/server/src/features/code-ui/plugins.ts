import { join } from "node:path";
import {
  type CodeUiWorkspace,
  type InstalledPlugin,
  zcodeInstalledPluginSummarySchema,
  zcodePluginsInstallParamsSchema,
  zcodePluginsInstallResultSchema,
  zcodePluginsListResultSchema,
  zcodePluginsOverviewResultSchema,
  zcodePluginsSetEnabledParamsSchema,
  zcodePluginsSetEnabledResultSchema,
  zcodePluginsUninstallParamsSchema,
  zcodePluginsUninstallResultSchema,
} from "@kenfutwork/shared";
import { z } from "zod";
import type { AdminService } from "../admin/admin-service.js";
import type { AuthenticatedUser } from "../auth/types.js";
import {
  PluginRegistryError,
  type PluginRegistryService,
} from "../plugins/plugin-registry-service.js";

const BUNDLED_MARKETPLACE = "kenfutwork-bundled";
const LOCAL_MARKETPLACE = "kenfutwork-local";
const targetSchema = z
  .object({
    workspacePath: z.string().trim().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    configScope: z.enum(["user", "workspace"]).optional(),
  })
  .strict();

type PackageInventory = Awaited<
  ReturnType<PluginRegistryService["readPackageInventory"]>
>;

function marketplaceResolver(inventory: PackageInventory) {
  const bundledIds = new Set(inventory.bundled.map((entry) => entry.id));
  return (id: string) =>
    bundledIds.has(id) ? BUNDLED_MARKETPLACE : LOCAL_MARKETPLACE;
}

function installedSummary(
  { record, rootPath }: PackageInventory["installed"][number],
  marketplaceForPlugin: (id: string) => string,
) {
  return zcodeInstalledPluginSummarySchema.parse({
    id: record.id,
    name: record.name,
    marketplace: marketplaceForPlugin(record.id),
    description: record.manifest.description,
    version: record.version,
    enabled: record.enabled,
    scope: "user",
    installPath: rootPath,
    installedAt: record.installedAt,
    listing: {
      displayName: record.manifest.title ?? record.name,
      ...(record.manifest.category
        ? { category: record.manifest.category }
        : {}),
    },
  });
}

/** 原 service 使用扁平参数，原协议 schema 使用 workspace 引用；仅转换宿主寻址。 */
function nativePluginInput<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.output<T> {
  const target = targetSchema
    .omit({ configScope: true })
    .passthrough()
    .parse(value);
  const { workspacePath, workspaceIdentity, ...fields } = target;
  return schema.parse({
    ...fields,
    workspace: {
      workspacePath,
      workspaceKey: workspaceIdentity ?? workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    },
  });
}

function pluginList(
  inventory: PackageInventory,
  marketplaceForPlugin: (id: string) => string,
  diagnostics: z.infer<typeof zcodePluginsListResultSchema>["diagnostics"],
) {
  return zcodePluginsListResultSchema.parse({
    plugins: inventory.installed.map(({ record, rootPath }) => ({
      id: record.id,
      name: record.name,
      description: record.manifest.description,
      version: record.version,
      enabled: record.enabled,
      source: record.repositoryUrl ?? record.source,
      marketplace: marketplaceForPlugin(record.id),
      rootPath,
      // KWF bundle 尚无原生ZCode skill/command/MCP根声明；不把tools伪装成MCP组件。
      skillRootCount: 0,
      commandRootCount: 0,
      mcpServerNames: [],
      rootSource: "user",
      enabledSource: "user",
    })),
    diagnostics,
  });
}

/** 原市场仅适配真实包服务；原 store/card/detail 负责所有界面装配。 */
export class CodeUiPluginsHost {
  constructor(
    private readonly deps: {
      registry: PluginRegistryService;
      admin: AdminService;
      workspace: (
        user: AuthenticatedUser,
        path: string,
      ) => Promise<CodeUiWorkspace>;
    },
  ) {}

  async call(
    user: AuthenticatedUser,
    method: string,
    value: unknown,
  ): Promise<{ result: unknown } | null> {
    if (method === "installPlugin")
      return { result: await this.install(user, value) };
    if (method === "uninstallPlugin")
      return { result: await this.uninstall(user, value) };
    if (method === "setPluginEnabled")
      return { result: await this.setEnabled(user, value) };
    if (!new Set(["getPluginsOverview", "listPlugins"]).has(method))
      return null;
    const target = targetSchema.parse(value);
    await this.deps.workspace(user, target.workspacePath);
    const inventory = await this.deps.registry.readPackageInventory();
    const bundledIds = new Set(inventory.bundled.map((entry) => entry.id));
    const installedIds = new Set(
      inventory.installed.map((entry) => entry.record.id),
    );
    const marketplaceForPlugin = marketplaceResolver(inventory);
    const diagnostics =
      target.configScope === "workspace"
        ? [
            {
              code: "host_scope_user_only",
              message: "当前插件库存属于本机宿主，项目覆盖尚未接通。",
              severity: "warning" as const,
            },
          ]
        : [];
    if (method === "listPlugins")
      return {
        result: pluginList(inventory, marketplaceForPlugin, diagnostics),
      };
    const local = inventory.installed.filter(
      (entry) => !bundledIds.has(entry.record.id),
    );
    return {
      result: zcodePluginsOverviewResultSchema.parse({
        marketplaces: [
          ...(inventory.bundled.length
            ? [
                {
                  id: BUNDLED_MARKETPLACE,
                  name: "KenFutWork 自带插件",
                  source: { type: "builtin" },
                  pluginCount: inventory.bundled.length,
                },
              ]
            : []),
          ...(local.length
            ? [
                {
                  id: LOCAL_MARKETPLACE,
                  name: "本机插件",
                  source: { type: "local", path: inventory.rootPath },
                  pluginCount: local.length,
                },
              ]
            : []),
        ],
        availablePlugins: inventory.bundled.map((entry) => ({
          id: entry.id,
          name: entry.name,
          marketplace: BUNDLED_MARKETPLACE,
          description: entry.manifest.description,
          version: entry.manifest.version,
          installed: installedIds.has(entry.id),
          listing: {
            displayName: entry.manifest.title ?? entry.name,
            ...(entry.manifest.category
              ? { category: entry.manifest.category }
              : {}),
          },
        })),
        installedPlugins: inventory.installed.map((entry) =>
          installedSummary(entry, marketplaceForPlugin),
        ),
        restorableBuiltins: [],
        diagnostics,
        capability: { supported: true },
      }),
    };
  }

  private async requireMutation(
    user: AuthenticatedUser,
    workspacePath: string,
    scope?: string,
  ) {
    await this.deps.admin.requireAdmin(user);
    await this.deps.workspace(user, workspacePath);
    if (scope === "workspace")
      throw new PluginRegistryError(
        "项目层插件安装或启停尚未接通，请使用本机用户层",
        "invalid_request",
      );
  }

  private async install(user: AuthenticatedUser, value: unknown) {
    const input = nativePluginInput(zcodePluginsInstallParamsSchema, value);
    await this.requireMutation(
      user,
      input.workspace.workspacePath,
      input.scope,
    );
    const inventory = await this.deps.registry.readPackageInventory();
    const bundle =
      input.marketplace === BUNDLED_MARKETPLACE &&
      inventory.bundled.find((entry) => entry.name === input.pluginName);
    if (!bundle)
      throw new PluginRegistryError("插件来源或名称不存在", "plugin_not_found");
    const diagnostics = bundle.report.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      severity: issue.severity === "blocker" ? "error" : "warning",
    }));
    if (input.dryRun)
      return zcodePluginsInstallResultSchema.parse({
        installedPlugins: [],
        dependencyClosure: [],
        diagnostics,
      });
    const { installed } = await this.deps.registry.install({
      builtin: bundle.name,
      allowLifecycleScripts: false,
      activation: "preserve",
    });
    return zcodePluginsInstallResultSchema.parse({
      installedPlugins: [
        installedSummary(
          {
            record: installed,
            rootPath: join(inventory.rootPath, installed.id),
          },
          marketplaceResolver(inventory),
        ),
      ],
      dependencyClosure: [],
      diagnostics,
    });
  }

  private async uninstall(user: AuthenticatedUser, value: unknown) {
    const input = nativePluginInput(zcodePluginsUninstallParamsSchema, value);
    await this.requireMutation(user, input.workspace.workspacePath);
    const inventory = await this.deps.registry.readPackageInventory();
    const marketplaceForPlugin = marketplaceResolver(inventory);
    const entry = inventory.installed.find(
      ({ record }) =>
        (input.pluginId
          ? record.id === input.pluginId
          : input.pluginName && record.name === input.pluginName) &&
        (!input.marketplace ||
          input.marketplace === marketplaceForPlugin(record.id)),
    );
    if (!entry) throw new PluginRegistryError("插件未安装", "not_installed");
    await this.deps.registry.uninstall(entry.record.id, {
      removeCache: input.removeCache ?? true,
    });
    return zcodePluginsUninstallResultSchema.parse({
      removedPlugin: installedSummary(
        { ...entry, record: { ...entry.record, enabled: false } },
        marketplaceForPlugin,
      ),
      diagnostics: [],
    });
  }

  private async setEnabled(user: AuthenticatedUser, value: unknown) {
    const input = nativePluginInput(zcodePluginsSetEnabledParamsSchema, value);
    await this.requireMutation(
      user,
      input.workspace.workspacePath,
      input.scope,
    );
    const installed: InstalledPlugin = await this.deps.registry.setEnabled(
      input.pluginId,
      input.enabled,
    );
    const inventory = await this.deps.registry.readPackageInventory();
    return zcodePluginsSetEnabledResultSchema.parse({
      enabled: input.enabled,
      plugin: pluginList(
        {
          ...inventory,
          installed: [
            {
              record: installed,
              rootPath: join(inventory.rootPath, installed.id),
            },
          ],
        },
        marketplaceResolver(inventory),
        [],
      ).plugins[0],
    });
  }
}
