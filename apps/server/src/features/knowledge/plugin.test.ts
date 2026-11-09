import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { createKnowledgePlugin } from "./plugin.js";
import type { SagRunner } from "./sag-cli-runner.js";
import {
  createBundleInspector,
  type PluginsServiceLike,
  toGateVerdict,
} from "./service.js";
import { KNOWLEDGE_BUNDLE_ID, type KnowledgeService } from "./types.js";

const testEnv: ServerEnv = {
  agentBackendMode: "state",
  agentModel: "test-model",
  port: 0,
  version: "test",
  webOrigin: "http://localhost:3000",
};

interface FakeEntry {
  id: string;
  name: string;
  installed: boolean;
  enabled?: boolean;
}

function fakePlugins(initial: FakeEntry[]): PluginsServiceLike & {
  set(entries: FakeEntry[]): void;
  throwOnList(message: string): void;
} {
  let entries = initial;
  let failure: string | undefined;
  return {
    async list() {
      if (failure) throw new Error(failure);
      return entries;
    },
    listUiEntries() {
      if (failure) throw new Error(failure);
      const active = entries.some(
        (entry) =>
          entry.id === KNOWLEDGE_BUNDLE_ID &&
          entry.installed &&
          entry.enabled !== false,
      );
      return active
        ? [
            {
              pluginId: `local__${KNOWLEDGE_BUNDLE_ID}`,
              id: "knowledge-sidebar",
            },
          ]
        : [];
    },
    set(next) {
      entries = next;
      failure = undefined;
    },
    throwOnList(message) {
      failure = message;
    },
  };
}

function composeWith(
  plugins: PluginsServiceLike | undefined,
  platform: NodeJS.Platform = "win32",
  runner?: SagRunner,
) {
  const app = Fastify({ logger: false });
  const kernel = composePlugins(
    testEnv,
    [
      createKnowledgePlugin({
        platform,
        // 单元测试不 spawn 真实 CLI：探测直接返回「系统已装」。
        probeCli: async () => true,
        ...(runner ? { runner } : {}),
      }),
    ],
    {
      app,
      ...(plugins ? { overrides: { plugins: plugins as never } } : {}),
    },
  );
  return {
    app,
    kernel,
    service: () => kernel.get("knowledge") as KnowledgeService,
  };
}

const searchOutput = JSON.stringify({
  protocol_version: 2,
  scope: "D:/kb",
  results: [
    {
      path: "a.md",
      absolute_path: "D:/kb/a.md",
      start_line: 10,
      end_line: 13,
      content: "重试逻辑说明",
    },
  ],
  truncated: false,
});

const configured = JSON.stringify({
  url: "https://api.302ai.cn/typesafeai/v1",
  model: "jev-latest",
  models: [],
  has_key: true,
  auth_mode: "bearer",
});

const rootsOutput = JSON.stringify([
  { path: "D:/kb", name: "kb", status: "ready", count: 1, error: null },
]);

/** 只读探针替身：config 已配置 + 一个根 + 检索返回固定证据。 */
const fakeRunner: SagRunner = async (run) => {
  const stdout =
    run.args[0] === "config"
      ? configured
      : run.args[0] === "list"
        ? rootsOutput
        : searchOutput;
  return { code: 0, stdout, stderr: "" };
};

const installed: FakeEntry[] = [
  { id: KNOWLEDGE_BUNDLE_ID, name: KNOWLEDGE_BUNDLE_ID, installed: true },
];

describe("knowledge 插件（M1 能力缝骨架）", () => {
  it("不写 enabled 判定即默认挂载", () => {
    expect(createKnowledgePlugin().enabled).toBeUndefined();
  });

  it("经内核装配后 knowledge 服务可取，未安装时 fail closed", async () => {
    const { app, kernel, service } = composeWith(fakePlugins([]));
    const verdict = await service().isActive();
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("未安装");
    const status = await service().status();
    expect(status).toMatchObject({
      installed: false,
      enabled: false,
      active: false,
      // CLI 可用性与安装态独立：探针替身报告系统 CLI 可用。
      cli: "available",
      cliVersion: "0.1.8",
    });
    expect(status.reason).toContain("未安装");
    await app.close();
    kernel.dispose();
  });

  it("安装态变化后下一轮立即生效，不缓存快照（装→卸→重装）", async () => {
    const plugins = fakePlugins([]);
    const { app, kernel, service } = composeWith(plugins);
    expect((await service().isActive()).ok).toBe(false);

    plugins.set(installed);
    expect((await service().isActive()).ok).toBe(true);
    expect((await service().status()).active).toBe(true);

    plugins.set([]);
    expect((await service().isActive()).ok).toBe(false);

    plugins.set(installed);
    expect((await service().isActive()).ok).toBe(true);
    await app.close();
    kernel.dispose();
  });

  it("已安装但停用时明确区分 installed / enabled", async () => {
    const plugins = fakePlugins([
      {
        id: KNOWLEDGE_BUNDLE_ID,
        name: KNOWLEDGE_BUNDLE_ID,
        installed: true,
        enabled: false,
      },
    ]);
    const { app, kernel, service } = composeWith(plugins);
    expect((await service().isActive()).message).toContain("已停用");
    expect(await service().status()).toMatchObject({
      installed: true,
      enabled: false,
      active: false,
    });
    await app.close();
    kernel.dispose();
  });

  it("注册表不可用 / list 抛错都 fail closed 且不泄漏堆栈", async () => {
    // 装配期由 inject 声明提前 fail loud（见最后一条用例）；此处直接测门控的
    // 运行期防御分支，覆盖 tryGet 返回 undefined 的异常路径。
    const unavailable = toGateVerdict(
      await createBundleInspector(() => undefined)(),
    );
    expect(unavailable.ok).toBe(false);
    expect(unavailable.message).toContain("插件注册表不可用");

    const plugins = fakePlugins(installed);
    plugins.throwOnList("磁盘读取失败");
    const broken = composeWith(plugins);
    const verdict = await broken.service().isActive();
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("插件状态查询失败");
    expect(verdict.message).toContain("磁盘读取失败");
    await broken.app.close();
    broken.kernel.dispose();
  });

  it("平台无原生二进制时即使已安装也不激活，且原因明确", async () => {
    const { app, kernel, service } = composeWith(
      fakePlugins(installed),
      "linux",
    );
    const status = await service().status();
    expect(status).toMatchObject({
      installed: true,
      enabled: true,
      active: false,
      cli: "unsupported_platform",
    });
    expect(status.reason).toContain("Windows x64 与 macOS Apple Silicon");
    await app.close();
    kernel.dispose();
  });

  it("缺少 plugins 提供者时装配 fail loud（能力缝三元组不完整即拒绝启动）", () => {
    const app = Fastify({ logger: false });
    expect(() =>
      composePlugins(testEnv, [createKnowledgePlugin()], { app }),
    ).toThrow(/knowledge 声明依赖 plugins，但没有任何插件提供它/);
    return app.close();
  });

  it("pre-step 接线：装了注入证据，卸了下一轮立即消失（不重启）", async () => {
    const plugins = fakePlugins([]);
    const { app, kernel } = composeWith(plugins, "win32", fakeRunner);
    const emit = (input: string, runId: string) =>
      kernel.events.emitPreStep({ input, runId });

    const before = await emit("查一下重试逻辑", "r1");
    expect(String(before.input)).not.toContain("knowledge_evidence");

    plugins.set(installed);
    const active = await emit("查一下重试逻辑", "r2");
    expect(String(active.input)).toContain("<knowledge_evidence>");
    expect(String(active.input)).toContain("D:/kb/a.md:10-13");

    plugins.set([]);
    const after = await emit("查一下重试逻辑", "r3");
    expect(String(after.input)).not.toContain("knowledge_evidence");
    await app.close();
    kernel.dispose();
  });

  it("置顶提示段随装载出现/消失（双 preset 一致）", async () => {
    const plugins = fakePlugins(installed);
    const { app, kernel } = composeWith(plugins, "win32", fakeRunner);
    const compose = (preset: "code" | "design") =>
      kernel.get("systemPrompt").compose({ preset });
    await expect(compose("code")).resolves.toContain("本地知识库");
    await expect(compose("design")).resolves.toContain("本地知识库");
    plugins.set([]);
    await expect(compose("code")).resolves.not.toContain("本地知识库");
    await expect(compose("design")).resolves.not.toContain("本地知识库");
    await app.close();
    kernel.dispose();
  });
});
