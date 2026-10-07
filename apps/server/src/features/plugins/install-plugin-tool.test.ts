import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createLocalInstanceService } from "../local-instance/service.js";
import { createInstallPluginTool } from "./install-plugin-tool.js";
import type { PluginRegistryService } from "./plugin-registry-service.js";

const ACTOR = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: null,
};
const CANVAS_ID = "canvas-1";

function makeDeps(
  overrides: { install?: (input: unknown) => Promise<unknown> } = {},
) {
  const install =
    overrides.install ??
    (async () => ({
      installed: { id: "local__demo", name: "demo", version: "1.0.0" },
      report: { compatible: true, issues: [] },
    }));
  const sandboxRoot = mkdtempSync(join(tmpdir(), "kfw-install-plugin-"));
  mkdirSync(join(sandboxRoot, CANVAS_ID, "my-plugin"), { recursive: true });
  return {
    sandboxRoot,
    deps: {
      registry: { install } as unknown as PluginRegistryService,
      localInstance: createLocalInstanceService({
        repository: { ensure: async () => ACTOR.instanceId },
        dataDir: sandboxRoot,
      }),
      sandboxRoot,
    },
  };
}

describe("install_plugin 工具（创造模式的插件产物收尾）", () => {
  it("实例主人从工作目录安装：把沙箱内路径传给注册表（不越界）", async () => {
    const calls: unknown[] = [];
    const { deps } = makeDeps({
      install: async (input) => {
        calls.push(input);
        return {
          installed: { id: "local__demo", name: "demo", version: "1.0.0" },
          report: { compatible: true, issues: [] },
        };
      },
    });
    const tool = createInstallPluginTool(deps);

    const result = (await tool.execute(
      { path: "my-plugin" },
      { canvasId: CANVAS_ID, actor: ACTOR },
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      installed: true,
      id: "local__demo",
      name: "demo",
    });
    expect(calls[0]).toMatchObject({ allowLifecycleScripts: false });
    expect(String((calls[0] as { url: string }).url)).toContain("my-plugin");
  });

  it("外来实例 / 缺画布 / 缺actor / 路径越界都如实拒绝", async () => {
    const { deps } = makeDeps();
    const tool = createInstallPluginTool(deps);
    await expect(
      tool.execute(
        { path: "my-plugin" },
        {
          canvasId: CANVAS_ID,
          actor: { ...ACTOR, instanceId: "foreign-instance" },
        },
      ),
    ).rejects.toThrow(/当前本地实例/);
    const okAdmin = createInstallPluginTool(makeDeps().deps);
    await expect(
      okAdmin.execute({ path: "my-plugin" }, { actor: ACTOR }),
    ).rejects.toThrow(/画布/);
    await expect(
      okAdmin.execute({ path: "my-plugin" }, { canvasId: CANVAS_ID }),
    ).rejects.toThrow(/可信本地实例/);
    await expect(
      okAdmin.execute(
        { path: "../../etc" },
        { canvasId: CANVAS_ID, actor: ACTOR },
      ),
    ).rejects.toThrow(/越出工作目录/);
  });

  it("兼容性门禁失败时把报告带给模型（不让它瞎猜）", async () => {
    const { deps } = makeDeps({
      install: async () => {
        const error = new Error(
          "兼容性校验未通过，已阻止安装：缺少 engines 声明",
        ) as Error & {
          report?: unknown;
        };
        error.report = { compatible: false, issues: [{ severity: "blocker" }] };
        throw error;
      },
    });
    const tool = createInstallPluginTool(deps);

    await expect(
      tool.execute(
        { path: "my-plugin" },
        { canvasId: CANVAS_ID, actor: ACTOR },
      ),
    ).rejects.toThrow(/门禁报告/);
  });

  it("安装调用只发生一次（拒绝路径不会偷偷安装）", async () => {
    const install = vi.fn(async () => ({
      installed: { id: "x", name: "x", version: "1" },
      report: { compatible: true, issues: [] },
    }));
    const { deps } = makeDeps({ install });
    const tool = createInstallPluginTool(deps);

    await expect(
      tool.execute(
        { path: "../outside" },
        { canvasId: CANVAS_ID, actor: ACTOR },
      ),
    ).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
  });
});
