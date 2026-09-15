import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import {
  createPluginRegistryService,
  PluginRegistryError,
} from "./plugin-registry-service.js";

/**
 * 插件注册表集成测试（真实内核注册表 + 真实落盘，不走网络）。
 *
 * 验收目标：装上就真的能用——工具进内核注册表、能执行、能卸载干净、
 * 重启能恢复；**门禁不通过时一个字节都不落盘**。
 */

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const EXAMPLE_PLUGIN = path.join(REPO_ROOT, "plugins", "example-clock");

function makeEnv(): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "test-model",
    port: 0,
    version: "test",
    webOrigin: "http://localhost:3000",
  } as ServerEnv;
}

let pluginsDir: string;
const kernels: Array<{ dispose(): void }> = [];

function makeService() {
  const kernel = composePlugins(makeEnv(), []);
  kernels.push(kernel);
  return {
    kernel,
    service: createPluginRegistryService({
      pluginsDir,
      tools: kernel.get("tools"),
      subscribe: () => () => {},
      hostNodeMajor: 22,
      builtinCatalog: [
        {
          name: "skills",
          title: "技能",
          description: "SKILL.md 技能发现与市场。",
          capabilities: ["tools"],
        },
      ],
    }),
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** 造一个注定被门禁拦下的 bundle（依赖 llm 能力）。 */
async function writeIncompatibleBundle(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "kenfutwork-bad-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "bad-plugin",
      version: "1.0.0",
      type: "module",
      main: "index.js",
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    }),
    "utf8",
  );
  await writeFile(
    path.join(dir, "cordis.patch.yml"),
    "- insert:\n    - id: bad\n      name: bad-plugin\n",
    "utf8",
  );
  await writeFile(
    path.join(dir, "index.js"),
    "export const inject = ['llm']\nexport function apply(ctx) {}\n",
    "utf8",
  );
  return dir;
}

beforeEach(async () => {
  pluginsDir = await mkdtemp(path.join(tmpdir(), "kenfutwork-plugins-"));
});

afterEach(async () => {
  for (const kernel of kernels.splice(0)) {
    kernel.dispose();
  }
  await rm(pluginsDir, { recursive: true, force: true });
});

describe("plugin-registry：安装并真的能用", () => {
  it("从本地目录安装参考插件后，工具进内核注册表且可执行", async () => {
    const { kernel, service } = makeService();
    const { installed, report } = await service.install({
      url: EXAMPLE_PLUGIN,
      allowLifecycleScripts: false,
    });

    expect(report.compatible).toBe(true);
    expect(report.supportedCapabilities).toEqual(["tools"]);
    expect(installed.name).toBe("kenfutwork-example-clock");

    const tool = kernel.get("tools").require("clock_now");
    expect(tool.scope).toBe("shared");

    const result = (await tool.execute({}, {})) as {
      iso?: string;
      epochMs?: number;
    };
    expect(result.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof result.epochMs).toBe("number");
    expect(result.epochMs).toBeGreaterThan(0);
  });

  it("安装后出现在列表里，且来源标记为已安装", async () => {
    const { service } = makeService();
    await service.install({
      url: EXAMPLE_PLUGIN,
      allowLifecycleScripts: false,
    });

    const entries = await service.list();
    const mine = entries.find((entry) => entry.name === "kenfutwork-example-clock");
    expect(mine).toBeDefined();
    expect(mine?.installed).toBe(true);
    expect(mine?.system).toBe(false);
    // 内置目录仍在列表里
    expect(entries.some((entry) => entry.source === "builtin")).toBe(true);
  });

  it("卸载后工具注销、落盘目录清除、列表不再有它", async () => {
    const { kernel, service } = makeService();
    const { installed } = await service.install({
      url: EXAMPLE_PLUGIN,
      allowLifecycleScripts: false,
    });
    await service.uninstall(installed.id);

    expect(kernel.get("tools").get("clock_now")).toBeUndefined();
    expect(await exists(path.join(pluginsDir, installed.id))).toBe(false);
    const entries = await service.list();
    expect(entries.some((entry) => entry.name === "kenfutwork-example-clock")).toBe(
      false,
    );
  });

  it("禁用注销工具，重新启用再注册（同一实例）", async () => {
    const { kernel, service } = makeService();
    const { installed } = await service.install({
      url: EXAMPLE_PLUGIN,
      allowLifecycleScripts: false,
    });

    await service.setEnabled(installed.id, false);
    expect(kernel.get("tools").get("clock_now")).toBeUndefined();

    await service.setEnabled(installed.id, true);
    expect(kernel.get("tools").get("clock_now")).toBeDefined();
  });

  it("重启后 restore() 从落盘状态恢复装载（持久化生效）", async () => {
    const first = makeService();
    const { installed } = await first.service.install({
      url: EXAMPLE_PLUGIN,
      allowLifecycleScripts: false,
    });
    // 模拟进程重启：全新内核 + 全新服务实例，同一 pluginsDir
    const second = makeService();
    await second.service.restore();

    expect(second.kernel.get("tools").get("clock_now")).toBeDefined();
    const entries = await second.service.list();
    expect(entries.some((entry) => entry.id === installed.id)).toBe(true);
  });

  it("重复安装同一来源是幂等的（不产生重名冲突、不重复列表）", async () => {
    const { kernel, service } = makeService();
    const first = await service.install({
      url: EXAMPLE_PLUGIN,
      allowLifecycleScripts: false,
    });
    const second = await service.install({
      url: EXAMPLE_PLUGIN,
      allowLifecycleScripts: false,
    });

    expect(second.installed.id).toBe(first.installed.id);
    expect(kernel.get("tools").get("clock_now")).toBeDefined();
    const entries = await service.list();
    expect(
      entries.filter((entry) => entry.name === "kenfutwork-example-clock"),
    ).toHaveLength(1);
  });
});

describe("plugin-registry：门禁拦截", () => {
  it("兼容性不通过的插件被拒绝，且不落盘、不装载、不进列表", async () => {
    const { kernel, service } = makeService();
    const badDir = await writeIncompatibleBundle();
    try {
      await expect(
        service.install({ url: badDir, allowLifecycleScripts: false }),
      ).rejects.toBeInstanceOf(PluginRegistryError);

      // 报告随错误回传，UI 才能解释为什么不能装
      const error = await service
        .install({ url: badDir, allowLifecycleScripts: false })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PluginRegistryError);
      expect(
        (error as PluginRegistryError).report?.unsupportedCapabilities,
      ).toEqual(["llm"]);

      const entries = await service.list();
      expect(entries.some((entry) => entry.name === "bad-plugin")).toBe(false);
      expect(kernel.get("tools").list()).toHaveLength(0);
      // 落盘目录里只有状态文件（若写入过），没有 bundle 目录
      expect(await exists(path.join(pluginsDir, "bad-plugin"))).toBe(false);
    } finally {
      await rm(badDir, { recursive: true, force: true });
    }
  });

  it("inspect 只校验不安装（无副作用）", async () => {
    const { kernel, service } = makeService();
    const { manifest, report } = await service.inspect({ url: EXAMPLE_PLUGIN });
    expect(report.compatible).toBe(true);
    expect(manifest.name).toBe("kenfutwork-example-clock");
    // 没有装载，也没有落盘
    expect(kernel.get("tools").get("clock_now")).toBeUndefined();
    const entries = await service.list();
    expect(entries.some((entry) => entry.name === "kenfutwork-example-clock")).toBe(
      false,
    );
  });

  it("来源不可识别时报错而不是静默成功", async () => {
    const { service } = makeService();
    await expect(
      service.install({
        url: "not-a-real-source",
        allowLifecycleScripts: false,
      }),
    ).rejects.toThrow();
  });

  it("卸载未安装的插件报 not_installed", async () => {
    const { service } = makeService();
    await expect(service.uninstall("nope")).rejects.toMatchObject({
      code: "not_installed",
    });
  });

  it("系统插件不可卸载", async () => {
    const { service } = makeService();
    await expect(service.uninstall("canvas")).rejects.toMatchObject({
      code: "system_plugin",
    });
  });
});

describe("plugin-registry：导出", () => {
  it("内置插件可导出为双声明 bundle", async () => {
    const { service } = makeService();
    const artifact = service.exportPlugin("skills", "dsh");
    const pkg = JSON.parse(artifact.files["package.json"]!) as {
      dsh?: unknown;
      kenfutwork?: unknown;
    };
    expect(pkg.dsh).toBeDefined();
    expect(pkg.kenfutwork).toBeDefined();
    expect(artifact.files["index.js"]).toBeDefined();
  });

  it("已装载插件的导出包含其真实工具 schema", async () => {
    const { service } = makeService();
    await service.install({
      url: EXAMPLE_PLUGIN,
      allowLifecycleScripts: false,
    });
    const artifact = service.exportPlugin("kenfutwork-example-clock", "dsh");
    const indexJs = artifact.files["index.js"]!;
    expect(indexJs).toContain("clock_now");
  });

  it("导出的参考插件回灌本项目仍通过门禁（往返闭环）", async () => {
    const { service } = makeService();
    await service.install({
      url: EXAMPLE_PLUGIN,
      allowLifecycleScripts: false,
    });
    const artifact = service.exportPlugin("kenfutwork-example-clock", "dsh");

    // 落盘为独立 bundle 后再走一次真实安装
    const dir = await mkdtemp(path.join(tmpdir(), "kenfutwork-roundtrip-"));
    try {
      await mkdir(dir, { recursive: true });
      for (const [relative, content] of Object.entries(artifact.files)) {
        await writeFile(path.join(dir, relative), content, "utf8");
      }
      const { report } = await service.install({
        url: dir,
        allowLifecycleScripts: false,
      });
      expect(report.compatible).toBe(true);
      expect(report.supportedCapabilities).toEqual(["tools"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 插件能力面 v1（用户拍板「插件拥有所有能力」后落地的一部分）：
 * 提示段（systemPrompt）/ 自带路由（routes）/ UI 入口（ui）都要能注册、能派发、能收回。
 */
describe("插件贡献物：提示段 / 路由 / UI 入口", () => {
  const CONTRIBUTOR = "loomic-contributor";

  async function writeContributor(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "kfw-contributor-"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: CONTRIBUTOR,
        version: "1.0.0",
        type: "module",
        main: "index.js",
        kenfutwork: { bundle: { patch: "./cordis.patch.yml" } },
      }),
      "utf8",
    );
    await writeFile(
      path.join(dir, "cordis.patch.yml"),
      `- insert:
    - id: ${CONTRIBUTOR}
      name: ${CONTRIBUTOR}
      inject: [tools, systemPrompt, routes, ui]
`,
      "utf8",
    );
    await writeFile(
      path.join(dir, "index.js"),
      `export const name = "${CONTRIBUTOR}";
export const inject = ["tools", "systemPrompt", "routes", "ui"];
export function apply(ctx) {
  ctx.promptFragments.register({ id: "tone", text: "回答一律先给结论。" });
  ctx.routes.register({
    path: "panel",
    public: true,
    handler: async () => ({ status: 200, body: "<h1>panel</h1>" }),
  });
  ctx.routes.register({
    path: "data",
    handler: async (request) => ({ ok: true, query: request.query }),
  });
  ctx.ui.register({ id: "panel", title: "插件面板", url: "/api/plugins/${CONTRIBUTOR}/panel" });
}
`,
      "utf8",
    );
    return dir;
  }

  it("注册后：提示段可见、公开路由可匿名访问、私有路由要登录、UI 入口带出", async () => {
    const { service } = makeService();
    const source = await writeContributor();
    const installed = await service.install({
      allowLifecycleScripts: false,
      url: source,
    });
    // 本机目录安装的 id 形如 local__<包名>：派发与卸载都用它
    const pluginId = installed.installed.id;

    expect(service.listPromptFragments()).toEqual(["回答一律先给结论。"]);
    const ui = service.listUiEntries();
    expect(ui).toHaveLength(1);
    expect(ui[0]).toMatchObject({ title: "插件面板", slot: "sidebar" });

    // 公开路由：匿名可访问
    const publicResult = await service.dispatchRoute({
      pluginId,
      method: "GET",
      path: "panel",
      query: {},
      body: undefined,
      headers: {},
      isAuthenticated: false,
    });
    expect(publicResult?.status).toBe(200);
    expect(publicResult?.body).toContain("panel");

    // 私有路由：未登录 401，登录后带参派发
    expect(
      await service.dispatchRoute({
        pluginId,
        method: "GET",
        path: "data",
        query: {},
        body: undefined,
        headers: {},
        isAuthenticated: false,
      }),
    ).toMatchObject({ status: 401 });

    const authed = await service.dispatchRoute({
      pluginId,
      method: "GET",
      path: "data",
      query: { q: "1" },
      body: undefined,
      headers: { authorization: "Bearer t" },
      isAuthenticated: true,
    });
    expect(authed).toMatchObject({ status: 200, body: { ok: true } });

    // 未注册路径 → undefined（路由层转 404）
    expect(
      await service.dispatchRoute({
        pluginId,
        method: "GET",
        path: "nope",
        query: {},
        body: undefined,
        headers: {},
        isAuthenticated: true,
      }),
    ).toBeUndefined();

    // 卸载后贡献物一并收回
    await service.uninstall(pluginId);
    expect(service.listPromptFragments()).toEqual([]);
    expect(service.listUiEntries()).toEqual([]);
    expect(
      service.routeVisibility({
        pluginId,
        method: "GET",
        path: "panel",
      }),
    ).toBeUndefined();
  });
});
