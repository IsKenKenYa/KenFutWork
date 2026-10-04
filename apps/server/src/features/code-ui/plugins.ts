import {
  type CodeUiWorkspace,
  zcodePluginsListResultSchema,
  zcodePluginsOverviewResultSchema,
} from "@kenfutwork/shared";
import { z } from "zod";
import type { AuthenticatedUser } from "../auth/types.js";
import type { PluginRegistryService } from "../plugins/plugin-registry-service.js";

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

/** 原市场读面仅投影真实包库存；原 store/card/detail 负责所有界面装配。 */
export class CodeUiPluginsHost {
  constructor(
    private readonly deps: {
      registry: PluginRegistryService;
      workspace: (
        user: AuthenticatedUser,
        path: string,
      ) => Promise<CodeUiWorkspace>;
    },
  ) {}

  async call(user: AuthenticatedUser, method: string, value: unknown) {
    if (!new Set(["getPluginsOverview", "listPlugins"]).has(method))
      return null;
    const target = targetSchema.parse(value);
    await this.deps.workspace(user, target.workspacePath);
    const inventory = await this.deps.registry.readPackageInventory();
    const bundledIds = new Set(inventory.bundled.map((entry) => entry.id));
    const installedIds = new Set(
      inventory.installed.map((entry) => entry.record.id),
    );
    const marketplaceForPlugin = (id: string) =>
      bundledIds.has(id) ? BUNDLED_MARKETPLACE : LOCAL_MARKETPLACE;
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
        installedPlugins: inventory.installed.map(({ record, rootPath }) => ({
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
        })),
        restorableBuiltins: [],
        diagnostics,
        capability: { supported: true },
      }),
    };
  }
}
