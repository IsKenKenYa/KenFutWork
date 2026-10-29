import { join } from "node:path";
import {
  type CodeUiWorkspace,
  createPluginIconResourceReference,
  type PluginBundleManifest,
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
  HOST_BUNDLED_PLUGIN_MARKETPLACE_ID,
  type ZCodePluginsReferenceCatalogResult,
  zcodePluginsDescribeParamsSchema,
  zcodePluginsDescribeResultSchema,
  zcodePluginsReferenceCatalogResultSchema,
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
const BUNDLED_MARKETPLACE = HOST_BUNDLED_PLUGIN_MARKETPLACE_ID;
const LOCAL_MARKETPLACE = "kenfutwork-local";
const referenceCatalogParamsSchema = targetSchema.extend({
  sessionId: z.string().trim().min(1).optional(),
});
/**
 * 会话级冻结目录。只在进程内保留：agent runtime 与本目录同进程，进程换代时两边
 * 一起重来，不会出现「目录冻结在旧版本、runtime 已是新版本」的错配。
 * 刻意不落库——会话表没有 metadata 列，且这不是需要跨重启的持久真相。
 */
const frozenReferenceCatalogs = new Map<
  string,
  ZCodePluginsReferenceCatalogResult
>();

/** 图标沿已有包资源端点读取，不把目录或凭据放进引用。 */
function pluginListing(id: string, manifest: PluginBundleManifest) {
  // 顶层 `kenfutwork.icon` 优先：没有 UI 面板的插件（CAD / Flow / Work…）靠它显示图标；
  // 老清单只声明了 `ui[].icon` 的仍按面板入口取，保持向后兼容。
  const declared = manifest.assets
    ? (manifest.icon ?? manifest.ui.find((entry) => entry.icon)?.icon)
    : undefined;
  const icon = declared
    ? createPluginIconResourceReference(id, declared)
    : undefined;
  return {
    displayName: manifest.title ?? manifest.name,
    ...(manifest.category ? { category: manifest.category } : {}),
    ...(icon ? { icon } : {}),
  };
}

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
    listing: pluginListing(record.id, record.manifest),
  });
}

/** 原业务字段继续由原schema校验；实例操作不伪造workspace/Task。 */
function nativePluginInput<T extends z.ZodType>(schema: T, value: unknown) {
  const parsed = targetSchema.passthrough().parse(value);
  const {
    workspacePath,
    workspaceIdentity,
    projectId,
    configScope,
    remoteSessionId,
    ...fields
  } = parsed;
  return {
    target: {
      workspacePath,
      workspaceIdentity,
      projectId,
      configScope,
      remoteSessionId,
    },
    input: schema.parse(fields),
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
  const installed = new Map(
    inventory.installed.map((entry) => [entry.record.id, entry.record]),
  );
  return (id: string) =>
    bundled.has(id) &&
    (!installed.has(id) || installed.get(id)?.source === "builtin")
      ? BUNDLED_MARKETPLACE
      : LOCAL_MARKETPLACE;
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
              name: "KenFutWork 官方插件",
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
      listing: pluginListing(entry.id, entry.manifest),
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
      zcodePluginsInstallParamsSchema.omit({ workspace: true }),
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
      zcodePluginsSetEnabledParamsSchema.omit({ workspace: true }),
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
      zcodePluginsDescribeParamsSchema.omit({ workspace: true }),
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
      zcodePluginsUninstallParamsSchema.omit({ workspace: true }),
      value,
    );
    if (!input.pluginId && !input.pluginName)
      throw new PluginRegistryError("请选择要卸载的插件。", "invalid_request");
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

  /**
   * 对话引用 catalog：Composer 的「+ → 插件」读这一份。
   *
   * 带 sessionId 时按会话冻结（进程内），不带时读 workspace 当前——契约要求
   * session-owned 不得被后续目录变化污染。这里没有会话级 runtime 快照可读，
   * 所以冻结粒度取「本进程」：与 agent runtime 同生命周期，不会出现目录旧、
   * runtime 新的错配。
   */
  async function referenceCatalog(actor: LocalActor, value: unknown) {
    const params = referenceCatalogParamsSchema.parse(value);
    await validateTarget(deps, actor, params);
    const sessionId = params.sessionId;
    if (sessionId) {
      const frozen = frozenReferenceCatalogs.get(sessionId);
      if (frozen) return frozen;
    }
    const inventory = await deps.registry.readPackageInventory();
    const marketplace = marketplaceResolver(inventory);
    // 同名 manifest 的启用插件互为冲突（V1 fail closed）：picker 禁选并给原因。
    const enabledByName = new Map<string, string[]>();
    for (const { record } of inventory.installed) {
      if (!record.enabled) continue;
      enabledByName.set(record.name, [
        ...(enabledByName.get(record.name) ?? []),
        record.id,
      ]);
    }
    const plugins = await Promise.all(
      inventory.installed.map(async ({ record }) => {
        const description = await deps.registry.readPackageDescription(
          record.id,
        );
        const listing = pluginListing(record.id, record.manifest);
        return {
          pluginId: record.id,
          name: record.name,
          marketplace: marketplace(record.id),
          enabled: record.enabled,
          conflictingPluginIds: record.enabled
            ? (enabledByName.get(record.name) ?? []).filter(
                (id) => id !== record.id,
              )
            : [],
          skillQualifiedNames: description.skills.map((skill) => skill.name),
          mcpServerNames: [],
          subagentNames: [],
          ...(record.manifest.description
            ? { description: record.manifest.description }
            : {}),
          ...(listing.displayName ? { displayName: listing.displayName } : {}),
          ...(listing.category ? { category: listing.category } : {}),
          ...(listing.icon ? { icon: listing.icon } : {}),
        };
      }),
    );
    const result = zcodePluginsReferenceCatalogResultSchema.parse({
      authority: sessionId ? "session" : "workspace",
      plugins,
    });
    if (sessionId) frozenReferenceCatalogs.set(sessionId, result);
    return result;
  }

  return {
    async call(
      actor: LocalActor,
      method: string,
      value: unknown,
    ): Promise<{ result: unknown } | null> {
      if (method === "getPluginReferenceCatalog")
        return { result: await referenceCatalog(actor, value) };
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
