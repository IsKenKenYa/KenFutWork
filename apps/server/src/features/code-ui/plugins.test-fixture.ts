import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunEventBus, ToolRegistryImpl } from "../../kernel/context.js";
import { createAdminService } from "../admin/admin-service.js";
import { createAdminRepository } from "../admin/repository.js";
import type { AuthenticatedUser } from "../auth/types.js";
import { createViewerRepository } from "../bootstrap/repository.js";
import { createCreditService } from "../credits/credit-service.js";
import { createCreditRepository } from "../credits/repository.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { buildBundleManifest } from "../plugins/bundle-manifest.js";
import { validateBundleFiles } from "../plugins/compat-validator.js";
import {
  type BundledBundle,
  createPluginRegistryService,
} from "../plugins/plugin-registry-service.js";
import type { PluginStorage } from "../plugins/plugin-storage.js";
import {
  type CodeUiPluginsTarget,
  createCodeUiPluginsHost,
} from "./plugins.js";

/** 只替换角色数据库边界；判定仍走原AdminService与原repositories。 */
export function createPluginAdminFixture(
  actor: Pick<AuthenticatedUser, "id">,
  options: { role?: "admin" | "user" } = {},
) {
  const runner: PostgresQueryRunner = {
    query: async (sql, values) => {
      if (sql !== "select role from public.profiles where id = $1")
        throw new Error("插件管理夹具只提供平台角色数据库读取");
      return {
        rowCount: 1,
        rows: [
          { role: values[0] === actor.id ? (options.role ?? "admin") : "user" },
        ],
      };
    },
    acquire: async () => {
      throw new Error("插件管理不应开启数据库写事务");
    },
    acquireSession: async () => {
      throw new Error("机器插件安装不得建立Task执行作用域");
    },
    end: async () => {},
  };
  const persistence = createPersistenceFromRunner(runner);
  return createAdminService({
    repository: createAdminRepository(persistence),
    workspaces: createViewerRepository(persistence),
    credits: createCreditService({
      repository: createCreditRepository(persistence),
    }),
  });
}

/** 同一真实package/registry用于原hostRPC与独立Adapter公共seam；不注册vitest用例。 */
export async function createPluginInventoryFixture(
  options: { storage?: PluginStorage } = {},
) {
  const directory = await mkdtemp(
    join(tmpdir(), "kfw-code-package-inventory-"),
  );
  const packageRoot = fileURLToPath(
    new URL("../../../../../plugins/example-clock/", import.meta.url),
  );
  const files: Record<string, string> = {};
  for (const name of await readdir(packageRoot))
    files[name] = await readFile(join(packageRoot, name), "utf8");
  const { manifest } = buildBundleManifest(files);
  const hostNodeMajor = Number.parseInt(
    process.versions.node.split(".")[0] ?? "0",
    10,
  );
  const report = validateBundleFiles(files, {
    hostNodeMajor,
    allowLifecycleScripts: false,
    fallbackName: manifest.name,
  });
  const bundled: BundledBundle = {
    id: `local__${manifest.name}`,
    name: manifest.name,
    files,
    manifest,
    report,
  };
  const tools = new ToolRegistryImpl(new AgentRunEventBus());
  const registry = createPluginRegistryService({
    pluginsDir: join(directory, "plugins"),
    tools,
    subscribe: () => () => {},
    hostNodeMajor,
    builtinCatalog: [],
    bundledBundles: [bundled],
    storage: options.storage ?? {
      get: async () => null,
      set: async () => {
        throw new Error("本包不读取插件数据");
      },
      remove: async () => false,
      keys: async () => [],
      purgePlugin: async () => 0,
    },
  });
  const actor = {
    id: randomUUID(),
    email: "inventory@example.test",
    accessToken: "private",
    userMetadata: {},
  };
  const workspaceId = randomUUID();
  return {
    actor,
    workspaceId,
    registry,
    tools,
    bundled,
    directory,
    packageRoot,
    async dispose() {
      try {
        await registry.shutdown();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

/** 原动作Adapter公共边界，可信项目元信息回调由主HTTP测试另行走真实解析器。 */
export async function createPluginManagementFixture(
  options: { storage?: PluginStorage } = {},
) {
  const actual = await createPluginInventoryFixture(options);
  const reader = { ...actual.actor, id: randomUUID() };
  const admin = createPluginAdminFixture(actual.actor);
  const projectId = randomUUID();
  const target = {
    workspacePath: actual.packageRoot,
    projectId,
    workspaceIdentity: JSON.stringify([projectId, actual.packageRoot]),
  };
  const deps = {
    registry: actual.registry,
    readWorkspaceId: async () => actual.workspaceId,
    workspace: async (_actor: unknown, value: CodeUiPluginsTarget) => {
      if (
        value.workspacePath !== target.workspacePath ||
        value.projectId !== target.projectId ||
        value.workspaceIdentity !== target.workspaceIdentity
      )
        throw new Error("项目插件目标无效");
      return {
        projectId,
        name: "插件目标",
        path: actual.packageRoot,
        additionalDirectories: [],
      };
    },
  };
  return {
    ...actual,
    target,
    reader,
    host: createCodeUiPluginsHost({ ...deps, admin }),
    withoutAdmin: createCodeUiPluginsHost(deps),
  };
}
