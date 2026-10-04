import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  type CodeExecutionScope,
} from "@kenfutwork/shared";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminService } from "../admin/admin-service.js";
import {
  createScopedBundleSource,
  fetchBundleFiles,
  type ScopedBundleSource,
} from "../plugins/bundle-source.js";
import { createInstallPluginTool } from "../plugins/install-plugin-tool.js";
import type { PluginRegistryService } from "../plugins/plugin-registry-service.js";
import { listScopedPluginBundles } from "../plugins/sandbox-plugin-bundles.js";
import {
  listScopedSkillPackages,
  readScopedSkillPackage,
} from "../skills/sandbox-skill-packages.js";
import { createExecutionScopes } from "./scope-service.js";

const actor = {
  id: randomUUID(),
  accessToken: "private",
  email: "admin@test.example",
  userMetadata: {},
};
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(
  limits: {
    codeSearchMaxResults?: number;
    codeReadMaxBytes?: number;
    codeSearchMaxBytes?: number;
  } = {},
) {
  const makeRoot = async () => {
    const path = await realpath(
      await mkdtemp(join(tmpdir(), "kfw-scoped-package-")),
    );
    temporary.push(path);
    return path;
  };
  const root = await makeRoot();
  const reference = await makeRoot();
  const outside = await makeRoot();
  const identity: CodeExecutionScope = {
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    taskId: randomUUID(),
    generation: 0,
    rootDirectory: root,
    additionalDirectories: [{ path: reference, access: "read-only" }],
    sandboxMode: "workspace-write",
  };
  let state: "ready" | "revoking" = "ready";
  const scopes = createExecutionScopes({
    repository: {
      load: async () => ({
        scope: structuredClone(identity),
        state,
        branchGeneration: 1,
      }),
    },
    viewerService: {
      resolveWorkspace: async () => ({ id: identity.workspaceId }) as never,
    },
    resolveFileLimits: async () => ({
      ...AGENT_GOVERNANCE_DEFAULTS,
      ...limits,
    }),
  });
  const scope = await scopes.openTask(actor, identity.taskId);
  const put = async (directory: string, name: string, content: string) => {
    const path = join(directory, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    return path;
  };
  return {
    root,
    reference,
    outside,
    scope,
    identity,
    put,
    revoke: () => {
      state = "revoking";
    },
  };
}
const manifest = (name: string) =>
  JSON.stringify({
    name,
    version: "1.0.0",
    kenfutwork: { bundle: { patch: "plugin.yml" } },
  });
const skill = (name: string) =>
  `---\nname: ${name}\ndescription: 测试\n---\n正文\n`;

it("Task候选覆盖主目录/只读附加目录，跳过隐藏/依赖/symlink和嵌套示例", async () => {
  const { root, reference, outside, scope, put } = await fixture();
  await put(root, "bundle/package.json", manifest("bundle"));
  await put(root, "bundle/examples/package.json", manifest("nested"));
  await put(root, "node_modules/ignored/package.json", manifest("ignored"));
  await put(root, ".hidden/package.json", manifest("hidden"));
  await put(root, "broken/package.json", "null");
  await put(root, "skill/skill.MD", skill("skill"));
  await put(root, "skill/references/demo/SKILL.md", skill("nested-skill"));
  await put(reference, "SKILL.md", skill("reference"));
  await put(outside, "package.json", manifest("secret"));
  await symlink(outside, join(root, "escape"));
  expect(
    (await listScopedPluginBundles(scope)).map((entry) => entry.name),
  ).toEqual(["bundle"]);
  expect(
    (await listScopedSkillPackages(scope)).map((entry) => entry.name).sort(),
  ).toEqual(["reference", "skill"]);
});

it("导入保留包内文本但不提供模型覆盖观察，越界/manifest symlink拒绝", async () => {
  const { root, outside, scope, put } = await fixture();
  const path = await put(root, "pkg/SKILL.md", skill("pkg"));
  await put(root, "pkg/scripts/run.py", "print('hi')");
  await put(root, "pkg/assets/binary.bin", "\0binary");
  expect(
    (await readScopedSkillPackage(scope, "pkg")).map((file) => file.path),
  ).toEqual(["SKILL.md", "scripts/run.py"]);
  await expect(
    scope.backend.writeFile({ path, content: "overwrite" }),
  ).rejects.toThrow(/读取/);
  const secret = await put(outside, "SKILL.md", skill("secret"));
  await expect(readScopedSkillPackage(scope, outside)).rejects.toMatchObject({
    code: "path_denied",
  });
  await mkdir(join(root, "link-pkg"));
  await symlink(secret, join(root, "link-pkg", "SKILL.md"));
  await expect(readScopedSkillPackage(scope, "link-pkg")).rejects.toThrow(
    "缺少 SKILL.md",
  );
});

it("包扫描/读取使用治理目录数和字节预算，超限不返回部分成功", async () => {
  const small = await fixture({ codeSearchMaxResults: 1 });
  await small.put(small.root, "a/SKILL.md", skill("a"));
  await expect(listScopedSkillPackages(small.scope)).rejects.toThrow("预算");
  const bytes = await fixture({
    codeReadMaxBytes: 1_024,
    codeSearchMaxBytes: 1_024,
  });
  await bytes.put(bytes.root, "pkg/SKILL.md", skill("pkg"));
  await bytes.put(bytes.root, "pkg/a.txt", "a".repeat(900));
  await bytes.put(bytes.root, "pkg/b.txt", "b".repeat(900));
  await expect(readScopedSkillPackage(bytes.scope, "pkg")).rejects.toThrow(
    "总字节数",
  );
});

it("本地bundle来源使用Task授权，撤销后枚举与读取都失败且无观察", async () => {
  const { root, outside, scope, put, revoke } = await fixture();
  const path = await put(root, "bundle/package.json", manifest("bundle"));
  await put(root, "bundle/index.js", "export default {};\n");
  await put(outside, "secret.json", '{"secret":true}');
  await symlink(
    join(outside, "secret.json"),
    join(root, "bundle", "secret.json"),
  );
  const source = createScopedBundleSource(scope);
  const loaded = await fetchBundleFiles(join(root, "bundle"), {
    localSource: source,
  });
  expect(Object.keys(loaded.files).sort()).toEqual([
    "index.js",
    "package.json",
  ]);
  await expect(
    scope.backend.writeFile({ path, content: "overwrite" }),
  ).rejects.toThrow(/读取/);
  await expect(
    fetchBundleFiles(outside, { localSource: source }),
  ).rejects.toMatchObject({ code: "path_denied" });
  const iterator = source
    .listFiles(join(root, "bundle"))
    [Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);
  revoke();
  await expect(iterator.next()).rejects.toMatchObject({
    code: "scope_unavailable",
  });
  await expect(source.readText(path)).rejects.toMatchObject({
    code: "scope_unavailable",
  });
});

it("install_plugin拒绝只读角色/越界/失效Task，Code上下文不退回Canvas", async () => {
  const { root, outside, scope, put, revoke } = await fixture();
  await put(root, "bundle/package.json", manifest("bundle"));
  const install = vi.fn(async () => ({
    installed: { id: "bundle", name: "bundle", version: "1" },
    report: { compatible: true, issues: [] },
  }));
  const tool = createInstallPluginTool({
    registry: { install } as unknown as PluginRegistryService,
    auth: { authenticate: async () => actor },
    admin: { requireAdmin: async () => {} } as unknown as AdminService,
  });
  await expect(
    tool.execute(
      { path: "bundle" },
      { scopeHandle: scope.derive("review"), accessToken: actor.accessToken },
    ),
  ).rejects.toThrow("只读");
  await expect(
    tool.execute(
      { path: outside },
      { scopeHandle: scope, accessToken: actor.accessToken },
    ),
  ).rejects.toMatchObject({ code: "path_denied" });
  await expect(
    tool.execute(
      { path: "bundle" },
      {
        canvasId: "legacy",
        codeApproval: {} as never,
        accessToken: actor.accessToken,
      },
    ),
  ).rejects.toThrow("明确的 Task");
  revoke();
  await expect(
    tool.execute(
      { path: "bundle" },
      { scopeHandle: scope, accessToken: actor.accessToken },
    ),
  ).rejects.toMatchObject({ code: "scope_unavailable" });
  expect(install).not.toHaveBeenCalled();
});

it("install_plugin使用Task真实根，安装来源在权限收紧后不再允许完成", async () => {
  const { root, scope, identity, put } = await fixture();
  await put(root, "bundle/package.json", manifest("bundle"));
  const install = vi.fn(
    async (input: { url: string; localSource: ScopedBundleSource }) => {
      expect(input.url).toBe(join(root, "bundle"));
      expect(
        (await fetchBundleFiles(input.url, { localSource: input.localSource }))
          .files["package.json"],
      ).toContain("bundle");
      identity.sandboxMode = "read-only";
      await input.localSource.resolvePath(input.url);
      throw new Error("安装不应到达这里");
    },
  );
  const tool = createInstallPluginTool({
    registry: { install } as unknown as PluginRegistryService,
    auth: { authenticate: async () => actor },
    admin: { requireAdmin: async () => {} } as unknown as AdminService,
  });
  await expect(
    tool.execute(
      { path: "bundle" },
      {
        scopeHandle: scope,
        canvasId: "must-not-be-used",
        accessToken: actor.accessToken,
      },
    ),
  ).rejects.toThrow("已收紧为只读");
  expect(install).toHaveBeenCalledTimes(1);
});
