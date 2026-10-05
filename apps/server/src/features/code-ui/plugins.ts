import { join } from "node:path";
import {
  type CodeUiWorkspace,
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
import {
  zcodePluginsDescribeParamsSchema,
  zcodePluginsDescribeResultSchema,
} from "@zcode/shared";
import { z } from "zod";
import type { LocalActor } from "../local-instance/types.js";
import {
  PluginRegistryError,
  type PluginRegistryService,
  SYSTEM_PLUGIN_NAMES,
} from "../plugins/plugin-registry-service.js";

export interface CodeUiPluginsTarget {
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  projectId?: string | undefined;
}
export interface CodeUiPluginsHostDeps {
  registry: PluginRegistryService;
  resolveInstanceId(actor: LocalActor): Promise<string>;
  workspace(
    actor: LocalActor,
    target: CodeUiPluginsTarget,
  ): Promise<CodeUiWorkspace>;
}
const targetSchema = z
  .object({
    workspacePath: z.string().trim().optional(),
    workspaceIdentity: z.string().trim().min(1).optional(),
    projectId: z.uuid().optional(),
    configScope: z.enum(["user", "workspace"]).optional(),
    remoteSessionId: z.string().trim().min(1).optional(),
  })
  .strict();
type Inventory = Awaited<
  ReturnType<PluginRegistryService["readPackageInventory"]>
>;
const BUNDLED_MARKETPLACE = "kenfutwork-bundled";
const LOCAL_MARKETPLACE = "kenfutwork-local";

function installedSummary(
  { record, rootPath }: Inventory["installed"][number],
  marketplace: (id: string) => string,
) {
  return zcodeInstalledPluginSummarySchema.parse({
    id: record.id,
    name: record.name,
    marketplace: marketplace(record.id),
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

/** 原service的扁平参数仅转为原协议workspace引用；identity不签执行权限。 */
function nativePluginInput<T extends z.ZodType>(schema: T, value: unknown) {
  const parsed = targetSchema
    .omit({ configScope: true })
    .passthrough()
    .parse(value);
  const {
    workspacePath,
    workspaceIdentity,
    projectId,
    remoteSessionId,
    ...fields
  } = parsed;
  if (!workspacePath)
    throw new PluginRegistryError(
      "项目插件管理必须提供真实工作目录。",
      "invalid_request",
    );
  return {
    target: { workspacePath, workspaceIdentity, projectId, remoteSessionId },
    input: schema.parse({
      ...fields,
      workspace: {
        workspacePath,
        workspaceKey: workspaceIdentity ?? workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      },
    }),
  };
}

async function validateTarget(
  deps: CodeUiPluginsHostDeps,
  actor: LocalActor,
  target: z.infer<typeof targetSchema>,
) {
  if (target.remoteSessionId)
    throw new Error("当前宿主未装配远程插件管理能力。");
  const hasTarget = Boolean(
    target.workspacePath || target.workspaceIdentity || target.projectId,
  );
  if (!hasTarget && target.configScope !== "workspace") return;
  if (!target.workspacePath)
    throw new Error("项目插件元信息读取必须提供真实工作目录。");
  await deps.workspace(actor, {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity
      ? { workspaceIdentity: target.workspaceIdentity }
      : {}),
    ...(target.projectId ? { projectId: target.projectId } : {}),
  });
}

function marketplaceResolver(inventory: Inventory) {
  const bundled = new Set(inventory.bundled.map((entry) => entry.id));
  return (id: string) =>
    bundled.has(id) ? BUNDLED_MARKETPLACE : LOCAL_MARKETPLACE;
}

function packageComponents(
  description: Awaited<
    ReturnType<PluginRegistryService["readPackageDescription"]>
  >,
) {
  return description.skills.length
    ? [{ kind: "skill" as const, items: description.skills }]
    : [];
}

async function listResult(
  inventory: Inventory,
  marketplace: (id: string) => string,
  diagnostics: z.infer<typeof zcodePluginsListResultSchema>["diagnostics"],
  registry: PluginRegistryService,
) {
  return zcodePluginsListResultSchema.parse({
    plugins: await Promise.all(
      inventory.installed.map(async ({ record, rootPath }) => {
        const description = await registry.readPackageDescription(record.id);
        return {
          id: record.id,
          name: record.name,
          description: record.manifest.description,
          version: record.version,
          enabled: record.enabled,
          source: record.repositoryUrl ?? record.source,
          marketplace: marketplace(record.id),
          rootPath,
          skillRootCount: description.skills.length ? 1 : 0,
          skillCount: description.skills.length,
          components: packageComponents(description),
          // 声明组件来自包文本；KWF tools贡献不能冒充MCP实例。
          commandRootCount: 0,
          mcpServerNames: [],
          rootSource: "user",
          enabledSource: "user",
        };
      }),
    ),
    diagnostics,
  });
}
function overviewResult(
  inventory: Inventory,
  marketplace: (id: string) => string,
  diagnostics: z.infer<typeof zcodePluginsListResultSchema>["diagnostics"],
) {
  const installed = new Set(
    inventory.installed.map((entry) => entry.record.id),
  );
  const local = inventory.installed.filter(
    (entry) => marketplace(entry.record.id) === LOCAL_MARKETPLACE,
  );
  return zcodePluginsOverviewResultSchema.parse({
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
      installed: installed.has(entry.id),
      listing: {
        displayName: entry.manifest.title ?? entry.name,
        ...(entry.manifest.category
          ? { category: entry.manifest.category }
          : {}),
      },
    })),
    installedPlugins: inventory.installed.map((entry) =>
      installedSummary(entry, marketplace),
    ),
    restorableBuiltins: [],
    diagnostics,
    capability: { supported: true },
  });
}
/** 原plugin-management机器包库存读面；项目解析只读，安装态由既有registry持有。 */
export function createCodeUiPluginsHost(deps: CodeUiPluginsHostDeps) {
  async function requireMutation(
    actor: LocalActor,
    target: z.infer<typeof targetSchema>,
    scope?: "user" | "workspace",
  ) {
    await deps.resolveInstanceId(actor);
    await validateTarget(deps, actor, target);
    if (scope === "workspace")
      throw new PluginRegistryError(
        "项目层插件安装或启停尚未接通，请使用本机用户层。",
        "invalid_request",
      );
  }

  async function install(actor: LocalActor, value: unknown) {
    const { target, input } = nativePluginInput(
      zcodePluginsInstallParamsSchema,
      value,
    );
    await requireMutation(actor, target, input.scope);
    const inventory = await deps.registry.readPackageInventory();
    const bundle =
      input.marketplace === BUNDLED_MARKETPLACE &&
      inventory.bundled.find((entry) => entry.name === input.pluginName);
    if (!bundle)
      throw new PluginRegistryError(
        "插件来源或名称不存在。",
        "plugin_not_found",
      );
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
    const { installed } = await deps.registry.install({
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

  async function setEnabled(actor: LocalActor, value: unknown) {
    const { target, input } = nativePluginInput(
      zcodePluginsSetEnabledParamsSchema,
      value,
    );
    await requireMutation(actor, target, input.scope);
    const installed = await deps.registry.setEnabled(
      input.pluginId,
      input.enabled,
    );
    const inventory = await deps.registry.readPackageInventory();
    const listed = await listResult(
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
      deps.registry,
    );
    return zcodePluginsSetEnabledResultSchema.parse({
      enabled: installed.enabled,
      plugin: listed.plugins[0],
    });
  }

  async function describe(actor: LocalActor, value: unknown) {
    const { target, input } = nativePluginInput(
      zcodePluginsDescribeParamsSchema,
      value,
    );
    await deps.resolveInstanceId(actor);
    await validateTarget(deps, actor, target);
    const inventory = await deps.registry.readPackageInventory();
    const marketplace = marketplaceResolver(inventory);
    const installed = inventory.installed.find(
      ({ record }) =>
        record.name === input.pluginName &&
        marketplace(record.id) === input.marketplace,
    );
    const bundled =
      input.marketplace === BUNDLED_MARKETPLACE
        ? inventory.bundled.find((entry) => entry.name === input.pluginName)
        : undefined;
    const id = installed?.record.id ?? bundled?.id;
    if (!id)
      throw new PluginRegistryError("插件来源或包不存在。", "plugin_not_found");
    const details = await deps.registry.readPackageDescription(id);
    return zcodePluginsDescribeResultSchema.parse({
      components: packageComponents(details),
      metadata: details.metadata,
    });
  }

  async function uninstall(actor: LocalActor, value: unknown) {
    const { target, input } = nativePluginInput(
      zcodePluginsUninstallParamsSchema,
      value,
    );
    await requireMutation(actor, target);
    const inventory = await deps.registry.readPackageInventory();
    const marketplace = marketplaceResolver(inventory);
    const entry = inventory.installed.find(
      ({ record }) =>
        (input.pluginId
          ? record.id === input.pluginId
          : Boolean(input.pluginName) && record.name === input.pluginName) &&
        (!input.marketplace || input.marketplace === marketplace(record.id)),
    );
    if (!entry) {
      if (input.pluginId && SYSTEM_PLUGIN_NAMES.has(input.pluginId))
        await deps.registry.uninstall(input.pluginId, {
          removeCache: input.removeCache ?? true,
        });
      throw new PluginRegistryError("插件未安装。", "not_installed");
    }
    await deps.registry.uninstall(entry.record.id, {
      removeCache: input.removeCache ?? true,
    });
    return zcodePluginsUninstallResultSchema.parse({
      removedPlugin: installedSummary(
        { ...entry, record: { ...entry.record, enabled: false } },
        marketplace,
      ),
      diagnostics: [],
    });
  }

  return {
    async call(
      actor: LocalActor,
      method: string,
      value: unknown,
    ): Promise<{ result: unknown } | null> {
      if (method === "describePlugin")
        return { result: await describe(actor, value) };
      if (method === "installPlugin")
        return { result: await install(actor, value) };
      if (method === "setPluginEnabled")
        return { result: await setEnabled(actor, value) };
      if (method === "uninstallPlugin")
        return { result: await uninstall(actor, value) };
      if (method !== "listPlugins" && method !== "getPluginsOverview")
        return null;
      const target = targetSchema.parse(value);
      await deps.resolveInstanceId(actor);
      await validateTarget(deps, actor, target);
      const inventory = await deps.registry.readPackageInventory();
      const marketplace = marketplaceResolver(inventory);
      const diagnostics: z.infer<
        typeof zcodePluginsListResultSchema
      >["diagnostics"] =
        target.configScope === "workspace"
          ? [
              {
                code: "host_scope_user_only",
                message: "当前插件库存属于本机宿主，项目覆盖尚未接通。",
                severity: "warning",
              },
            ]
          : [];
      return {
        result:
          method === "listPlugins"
            ? await listResult(
                inventory,
                marketplace,
                diagnostics,
                deps.registry,
              )
            : overviewResult(inventory, marketplace, diagnostics),
      };
    },
  };
}
