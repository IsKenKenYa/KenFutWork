import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import type { KernelHandle } from "../../kernel/types.js";
import { buildBundleManifest } from "./bundle-manifest.js";
import { validateBundleFiles } from "./compat-validator.js";
import { readBundleSkills } from "./package-description.js";
import {
  type BundledBundle,
  createPluginRegistryService,
  type PluginRegistryService,
} from "./plugin-registry-service.js";
import { createPersistentPluginStorage } from "./plugin-storage.test-fixture.js";

/**
 * Jev 判决插件（移植自 ZCode 官方插件 jev-decisions）。
 * 锁三件事：bundle 过门禁、随包技能被扫描发现（含归属与许可文本）、
 * 安装/停用/卸载/重装在技能库存上的真实生效——技能正文读的是**安装副本**，
 * 重装必须把新内容带进去，否则仓库改了技能而运行实例永远停在旧版。
 */

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const JEV_DIR = path.join(REPO_ROOT, "plugins", "jev");
const PLUGIN_ID = "bundled__kenfutwork-jev";

function readJevFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const item of readdirSync(path.join(JEV_DIR, rel), {
      withFileTypes: true,
    })) {
      const child = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) walk(child);
      else files[child] = readFileSync(path.join(JEV_DIR, child), "utf8");
    }
  };
  walk("");
  return files;
}

function jevBundle(files = readJevFiles()): BundledBundle {
  return {
    id: PLUGIN_ID,
    name: "kenfutwork-jev",
    files,
    manifest: buildBundleManifest(files).manifest,
    report: validateBundleFiles(files, {
      hostNodeMajor: 22,
      allowLifecycleScripts: false,
      fallbackName: "kenfutwork-jev",
    }),
  };
}

function makeEnv(): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "test-model",
    port: 0,
    version: "test",
    webOrigin: "http://localhost:3000",
  } as ServerEnv;
}

describe("Jev bundle 与随包技能", () => {
  it("门禁通过，清单带市场卡片元信息", () => {
    const bundle = jevBundle();
    expect(bundle.report.compatible).toBe(true);
    expect(bundle.manifest).toMatchObject({
      name: "kenfutwork-jev",
      title: "Jev 判决",
      category: "开发者工具",
      icon: "assets/icon.svg",
    });
  });

  it("技能被扫描发现：工具表、归属链与许可文本齐全", () => {
    const skills = readBundleSkills(jevBundle().files);
    expect(skills).toHaveLength(1);
    const skill = skills[0];
    if (!skill) throw new Error("技能未被发现");
    expect(skill.name).toBe("jev-judgment");
    expect(skill.relativePath).toBe("skills/jev-judgment/SKILL.md");
    expect(skill.description).toContain("jev_verify");
    expect(skill.description).toContain("jev_gate");
    // 十一个工具的选型表是技能的核心价值，移植不得丢
    for (const tool of [
      "jev_screen",
      "jev_verify",
      "jev_noul",
      "jev_find",
      "jev_rerank",
      "jev_classify",
      "jev_decide",
      "jev_compare",
      "jev_extract",
      "jev_review",
      "jev_gate",
    ]) {
      expect(skill.content, tool).toContain(`\`${tool}\``);
    }
    // 归属链（MIT 义务）：上游包 → ZCode 插件 → 本仓
    expect(skill.content).toContain("@jkudish/jev-mcp");
    expect(skill.content).toContain("jev-decisions");
    expect(skill.content).toContain("kittimzhe");
    const license = skill.files.find((file) => file.path === "LICENSE.txt");
    expect(license?.content).toContain("MIT License");
    expect(license?.content).toContain("Copyright (c) 2026 Joey Kudish");
  });
});

describe("Jev 安装态与技能库存", () => {
  let pluginsDir: string;
  let kernel: KernelHandle;
  let service: PluginRegistryService;

  beforeEach(async () => {
    pluginsDir = await mkdtemp(path.join(tmpdir(), "kenfutwork-jev-"));
    kernel = composePlugins(makeEnv(), []);
    service = createPluginRegistryService({
      pluginsDir,
      tools: kernel.get("tools"),
      subscribe: () => () => {},
      hostNodeMajor: 22,
      builtinCatalog: [],
      bundledBundles: [jevBundle()],
      storage: createPersistentPluginStorage(
        path.join(pluginsDir, "storage.json"),
      ).storage,
    });
  });

  afterEach(async () => {
    await service.shutdown();
    kernel.dispose();
    await rm(pluginsDir, { recursive: true, force: true });
  });

  it("未安装没有技能；装上即进启用库存；停用收回；卸载清零", async () => {
    expect(await service.readSkillPackages()).toEqual([]);

    await service.install({
      builtin: "kenfutwork-jev",
      allowLifecycleScripts: false,
    });
    const installed = await service.readSkillPackages();
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({
      pluginId: PLUGIN_ID,
      enabled: true,
    });
    expect(installed[0]?.skills[0]?.name).toBe("jev-judgment");

    await service.setEnabled(PLUGIN_ID, false);
    const disabled = await service.readSkillPackages();
    expect(disabled[0]?.enabled).toBe(false);

    await service.setEnabled(PLUGIN_ID, true);
    await service.uninstall(PLUGIN_ID);
    expect(await service.readSkillPackages()).toEqual([]);
  });

  it("重装把新技能内容带进安装副本（仓库更新后实例跟得上）", async () => {
    await service.install({
      builtin: "kenfutwork-jev",
      allowLifecycleScripts: false,
    });
    // 模拟服务端重启：旧服务收掉，新服务读到新的自带 bundle
    await service.shutdown();

    const updatedFiles = readJevFiles();
    updatedFiles["skills/jev-judgment/SKILL.md"] +=
      "\n<!-- reinstall-probe -->\n";
    service = createPluginRegistryService({
      pluginsDir,
      tools: kernel.get("tools"),
      subscribe: () => () => {},
      hostNodeMajor: 22,
      builtinCatalog: [],
      bundledBundles: [jevBundle(updatedFiles)],
      storage: createPersistentPluginStorage(
        path.join(pluginsDir, "storage.json"),
      ).storage,
    });
    await service.install({
      builtin: "kenfutwork-jev",
      allowLifecycleScripts: false,
    });
    const packages = await service.readSkillPackages();
    expect(packages).toHaveLength(1);
    expect(packages[0]?.skills[0]?.content).toContain("reinstall-probe");
  });
});
