import { describe, expect, it } from "vitest";

import {
  resolveWorkEntry,
  type WorkHostStatusResponse,
  workEditorCategorySchema,
  workEditorInstallStatusSchema,
  workEditorMountSchema,
  workEditorPinnedReleaseSchema,
  workEditorSchema,
  workHostEditorsResponseSchema,
  workHostStatusResponseSchema,
} from "./work-host.js";

describe("resolveWorkEntry 入口门控", () => {
  const up: WorkHostStatusResponse = {
    enabled: true,
    registeredEditors: 12,
    reasons: [],
  };

  it("插件未安装 → 不可用，原因指向插件市场", () => {
    expect(
      resolveWorkEntry({
        pluginInstalled: false,
        pluginEnabled: false,
        status: up,
      }),
    ).toEqual({
      available: false,
      reason: "未安装 work 插件（插件市场可安装）。",
    });
  });

  it("插件已装但停用 → 不可用，原因点名停用", () => {
    expect(
      resolveWorkEntry({
        pluginInstalled: true,
        pluginEnabled: false,
        status: up,
      }),
    ).toEqual({
      available: false,
      reason: "Work 插件已停用。",
    });
  });

  it("探针请求失败（null）→ 按不可用处理，不猜「也许能用」", () => {
    expect(
      resolveWorkEntry({
        pluginInstalled: true,
        pluginEnabled: true,
        status: null,
      }),
    ).toEqual({
      available: false,
      reason: "无法获取 work 宿主状态（/api/work/host/status 不可达）。",
    });
  });

  it("适配层 disabled → 透出可读原因", () => {
    expect(
      resolveWorkEntry({
        pluginInstalled: true,
        pluginEnabled: true,
        status: { enabled: false, registeredEditors: 0, reasons: ["缺什么。"] },
      }),
    ).toEqual({ available: false, reason: "宿主适配层未配齐：缺什么。" });
    expect(
      resolveWorkEntry({
        pluginInstalled: true,
        pluginEnabled: true,
        status: { enabled: false, registeredEditors: 0, reasons: [] },
      }).reason,
    ).toBe("宿主适配层未配齐。");
  });

  it("安装 + 启用 + 探针可用 → available，不带多余字段", () => {
    expect(
      resolveWorkEntry({
        pluginInstalled: true,
        pluginEnabled: true,
        status: up,
      }),
    ).toEqual({
      available: true,
    });
  });
});

describe("编辑器扩展包契约", () => {
  const editor = {
    id: "gridcraft",
    title: "表格",
    category: "office",
    repo: "https://github.com/storytold/gridcraft",
    license: "MIT OR Apache-2.0",
    mount: "wasm-iframe",
    pinned: {
      version: "0.11.1",
      asset: "gridcraft-web-0.11.1.zip",
      bytes: 7571063,
      sha256: "b".repeat(64),
      url: "https://github.com/storytold/gridcraft/releases/download/v0.11.1/gridcraft-web-0.11.1.zip",
    },
    installed: false,
  };

  it("注册项形状：元数据 + 锚定发布 + 落位事实全闭合", () => {
    const parsed = workEditorSchema.parse(editor);
    expect(parsed.installed).toBe(false);
    expect(parsed.pinned?.version).toBe("0.11.1");
    // 封闭枚举：类别与挂载点不能塞进任意字符串
    expect(workEditorCategorySchema.safeParse("filesystem").success).toBe(
      false,
    );
    expect(workEditorMountSchema.safeParse("teleport").success).toBe(false);
    expect(
      workEditorSchema.safeParse({ ...editor, installed: "yes" }).success,
    ).toBe(false);
  });

  it("未锚定编辑器 pinned=null 合法；sha256 必须是 64 位十六进制", () => {
    expect(
      workEditorSchema.parse({ ...editor, pinned: null }).pinned,
    ).toBeNull();
    expect(
      workEditorPinnedReleaseSchema.safeParse({
        ...editor.pinned,
        sha256: "xyz",
      }).success,
    ).toBe(false);
  });

  it("status/editors 响应形状按契约校验（editors 带安装状态快照）", () => {
    expect(
      workHostStatusResponseSchema.safeParse({
        enabled: true,
        registeredEditors: 12,
        reasons: [],
      }).success,
    ).toBe(true);
    expect(
      workHostStatusResponseSchema.safeParse({
        enabled: true,
        registeredEditors: -1,
        reasons: [],
      }).success,
    ).toBe(false);
    expect(
      workHostEditorsResponseSchema.safeParse({
        editors: [],
        dataDir: "D:/data",
        install: {},
      }).success,
    ).toBe(true);
    expect(
      workHostEditorsResponseSchema.safeParse({
        editors: [],
        dataDir: "D:/data",
        install: {
          gridcraft: { state: "ready", logTail: [] },
        },
      }).success,
    ).toBe(true);
    expect(
      workHostEditorsResponseSchema.safeParse({
        editors: [],
        dataDir: "D:/data",
        install: { gridcraft: { state: "paused", logTail: [] } },
      }).success,
    ).toBe(false);
    expect(
      workEditorInstallStatusSchema.safeParse({
        state: "error",
        logTail: ["安装失败：HTTP 500"],
        error: "HTTP 500",
      }).success,
    ).toBe(true);
  });
});
