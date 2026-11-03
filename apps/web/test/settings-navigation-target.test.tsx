import type { ManagementTarget } from "@kenfutwork/shared";
import { cleanup } from "@testing-library/react";
import { setPendingSettingsSectionIntent } from "@zui/lib/settingsNavigation.js";
import { createTabStore, type SettingsOpenTarget } from "@zui/store/tabStore.js";
import { afterEach, expect, it } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});

const skillsTarget: SettingsOpenTarget = {
  page: "settings",
  section: "plugin",
  pluginTab: "skills",
  pluginScopeKey: "user",
};
const mcpsTarget: SettingsOpenTarget = {
  page: "settings",
  section: "plugin",
  pluginTab: "mcps",
  pluginScopeKey: "user",
};

it("入口带目标时宿主直接转发，不被共享存储里的残留意图覆盖", () => {
  const forwarded: ManagementTarget[] = [];
  // 另一文档留下的“常规”意图：旧实现会回读它，把技能入口送到常规。
  setPendingSettingsSectionIntent("general");
  const platform = createCodePlatform({} as CodeHttpChannelClient, {
    onOpenManagement: (target) => forwarded.push(target),
  });

  platform.openSettingsDocument?.(skillsTarget);

  expect(forwarded).toEqual([skillsTarget]);
});

it("连续点击同一入口每次都按技能页签转发", () => {
  const calls: Array<ManagementTarget | undefined> = [];
  const store = createTabStore(null, {
    onOpenSettings: (target) => calls.push(target),
  });

  store.getState().openSettingsTab(skillsTarget);
  store.getState().openSettingsTab(skillsTarget);

  expect(calls).toEqual([skillsTarget, skillsTarget]);
});

it("切换模式重建窗口后首次进入，仍按技能页签转发", () => {
  const calls: Array<ManagementTarget | undefined> = [];
  const open = (target: SettingsOpenTarget) => {
    const store = createTabStore(null, {
      onOpenSettings: (next) => calls.push(next),
    });
    store.getState().openSettingsTab(target);
  };

  open(mcpsTarget);
  // 切换模式：旧窗口 store 丢弃，新窗口首次进入。
  open(skillsTarget);

  expect(calls).toEqual([mcpsTarget, skillsTarget]);
});

it("无显式目标的老入口仍回读一次跳转意图", () => {
  const forwarded: ManagementTarget[] = [];
  setPendingSettingsSectionIntent("plugin", {
    pluginTab: "skills",
    pluginScopeKey: "user",
  });
  const platform = createCodePlatform({} as CodeHttpChannelClient, {
    onOpenManagement: (target) => forwarded.push(target),
  });

  platform.openSettingsDocument?.();

  expect(forwarded).toEqual([
    {
      page: "settings",
      section: "plugin",
      pluginTab: "skills",
      pluginScopeKey: "user",
    },
  ]);
});
