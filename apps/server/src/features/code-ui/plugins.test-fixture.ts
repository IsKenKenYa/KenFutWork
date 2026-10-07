import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunEventBus, ToolRegistryImpl } from "../../kernel/context.js";
import type { LocalActor } from "../local-instance/types.js";
import { buildBundleManifest } from "../plugins/bundle-manifest.js";
import { validateBundleFiles } from "../plugins/compat-validator.js";
import {
  type BundledBundle,
  createPluginRegistryService,
} from "../plugins/plugin-registry-service.js";
import type { PluginStorage } from "../plugins/plugin-storage.js";
import { createCodeUiTestInstance } from "./host-session.fixture.js";
import {
  type CodeUiPluginsTarget,
  createCodeUiPluginsHost,
} from "./plugins.js";

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
  const instanceId = randomUUID();
  const actor = { instanceId, accessClientId: null };
  return {
    actor,
    instanceId,
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
  const foreignActor: LocalActor = {
    instanceId: randomUUID(),
    accessClientId: null,
  };
  const { localInstance } = createCodeUiTestInstance(
    actual.instanceId,
    null,
    actual.directory,
  );
  const projectId = randomUUID();
  const target = {
    workspacePath: actual.packageRoot,
    projectId,
    workspaceIdentity: JSON.stringify([projectId, actual.packageRoot]),
  };
  const deps = {
    registry: actual.registry,
    resolveInstanceId: async (actor: LocalActor) =>
      (await localInstance.resolve(actor)).instanceId,
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
    foreignActor,
    host: createCodeUiPluginsHost(deps),
  };
}
