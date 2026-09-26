import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VoiceSettingsSection } from "../src/components/workbench/voice-settings-section.js";

/**
 * 设置 → 语音（规划 §7）。锁三条产品口径：
 * 1. **未选择 = 不下载**：只有离线候选带「下载」按钮；
 * 2. **不摆空壳**：不可选候选择灰且写明原因；
 * 3. **保存是部分更新**：改一个开关不夹带其它字段（历史事故：默认值把设置重置）。
 */

const MODEL_BUILTIN = {
  id: "sensevoice-small-int8",
  segment: "listen" as const,
  label: "SenseVoice Small（int8）",
  kind: "builtin" as const,
  location: "cpu" as const,
  sizeBytes: 239_549_735,
  needsDownload: true,
  download: {
    state: "missing" as const,
    downloadedBytes: 0,
    totalBytes: 239_549_735,
  },
  license: "FunASR Model License",
};

const MODEL_INSTANCE = {
  id: "inst-1",
  segment: "listen" as const,
  label: "我的网关 · whisper-1",
  kind: "instance" as const,
  location: "remote" as const,
  model: "whisper-1",
  sizeBytes: 0,
  needsDownload: false,
  download: { state: "ready" as const, downloadedBytes: 0, totalBytes: 0 },
};

const MODEL_DISABLED = {
  ...MODEL_INSTANCE,
  id: "inst-2",
  label: "停用的网关 · whisper-1",
  unavailableReason: "该供应商实例已停用",
};

type StubSettings = {
  mode: "transcribe" | "loop";
  listen: { kind: string; id: string; model?: string } | null;
  think: { kind: string; id: string } | null;
  speak: { kind: string; id: string } | null;
  speakReplies: boolean;
};

const SETTINGS: StubSettings = {
  mode: "transcribe",
  listen: null,
  think: null,
  speak: null,
  speakReplies: false,
};

const REPORT = {
  hardware: {
    cpuModel: "Test CPU",
    cpuCores: 12,
    totalMemoryBytes: 32 * 1024 ** 3,
    platform: "win32",
  },
  listen: {
    state: "measured" as const,
    summary: "实测 7 次的中位实时率 0.08。",
    listen: { samples: 7, rtfMedian: 0.081, modelLoadMs: 2_700 },
  },
  think: { state: "unavailable" as const, summary: "未选择「想」模型。" },
  speak: { state: "unavailable" as const, summary: "内置档待定。" },
  measuredAt: "2026-09-26T10:00:00.000Z",
};

const saves: Array<Record<string, unknown>> = [];
const actions: string[] = [];

function stubApi(
  options: {
    settings?: typeof SETTINGS;
    models?: unknown[];
    report?: unknown;
  } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (path.endsWith("/api/voice/settings")) {
        if (init?.method === "PUT") {
          saves.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return json({
            settings: {
              ...SETTINGS,
              ...(JSON.parse(String(init.body)) as object),
            },
          });
        }
        return json({ settings: options.settings ?? SETTINGS });
      }
      if (path.includes("/api/voice/models/")) {
        // 记下**完整**路径与方法：漏掉 /download 后缀这类缺陷只能靠这条锁住
        actions.push(`${init?.method ?? "GET"} ${path.split("/api")[1]}`);
        return json({ model: MODEL_BUILTIN });
      }
      if (path.endsWith("/api/voice/models")) {
        return json({
          models: options.models ?? [MODEL_BUILTIN, MODEL_INSTANCE],
        });
      }
      if (path.endsWith("/api/voice/diagnose")) {
        // 用 "report" in options 判定：显式传 null（还没测过）不能被 ?? 吞掉
        return json({ report: "report" in options ? options.report : REPORT });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

beforeEach(() => {
  saves.length = 0;
  actions.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount(options: Parameters<typeof stubApi>[0] = {}) {
  stubApi(options);
  render(<VoiceSettingsSection accessToken="tok" />);
  // 等功能模式出现（load 完成）；各用例自己再查它关心的候选
  await screen.findByText(/功能模式/);
}

describe("语音设置页", () => {
  it("三段各出一个选择器，离线/在线与体积都写在卡片上", async () => {
    await mount();
    // 三个段各出一个选择组（用 aria-label 定位，免得撞上说明文案里的「听 / 想 / 说」）
    for (const segment of ["听段模型", "想段模型", "说段模型"]) {
      expect(screen.getByRole("group", { name: segment })).toBeTruthy();
    }
    expect(screen.getAllByText(/离线 · 本机 CPU/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/在线 · 端点/).length).toBeGreaterThan(0);
    // 体积要显示（用户按体积决策下载）：直接读卡片文本，避开 "文字被拆成多个元素" 的匹配问题
    const builtinCard = screen
      .getByText("SenseVoice Small（int8）")
      .closest("label");
    expect(builtinCard?.textContent).toContain("离线");
    expect(builtinCard?.textContent).toContain("228.5 MB");
  });

  it("未选择 = 不下载：离线候选带「下载」按钮，在线候选不带", async () => {
    await mount();
    // 只有 1 条离线候选（听段）→ 只有 1 个下载按钮
    expect(screen.getAllByRole("button", { name: "下载" })).toHaveLength(1);
  });

  it("不可选候选择灰并写明原因（不摆空壳、不放假开关）", async () => {
    await mount({ models: [MODEL_DISABLED] });
    const reason = await screen.findByText("该供应商实例已停用");
    expect(reason).toBeTruthy();
    const radio = screen.getByRole("radio", {
      name: /停用的网关/,
    }) as HTMLInputElement;
    expect(radio.disabled).toBe(true);
  });

  it("选一个在线候选：只送这一段（部分更新，不夹带其它字段）", async () => {
    await mount();
    fireEvent.click(
      screen.getByRole("radio", { name: /我的网关 · whisper-1/ }),
    );
    await vi.waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    expect(saves[0]).toEqual({
      listen: { kind: "instance", id: "inst-1", model: "whisper-1" },
    });
  });

  it("切换模式：同样只送 mode", async () => {
    await mount();
    fireEvent.click(screen.getByRole("radio", { name: /完整回路/ }));
    await vi.waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    expect(saves[0]).toEqual({ mode: "loop" });
  });

  it("完整回路模式才出现「朗读回复」开关（只转文本时不给无用开关）", async () => {
    await mount();
    expect(screen.queryByRole("checkbox", { name: "朗读回复" })).toBeNull();

    cleanup();
    await mount({ settings: { ...SETTINGS, mode: "loop" } });
    expect(screen.getByRole("checkbox", { name: "朗读回复" })).toBeTruthy();
  });

  it("点「下载」打到**带 /download 后缀**的端点（真机踩过：漏后缀 404，按钮看着能点其实没成）", async () => {
    await mount();
    const downloadBtn = screen.getByRole("button", { name: "下载" });
    fireEvent.click(downloadBtn);
    await vi.waitFor(() => {
      expect(actions).toContain(
        "POST /voice/models/sensevoice-small-int8/download",
      );
    });
    // 不允许出现「打到没有该路由的裸 id 路径」这种退化
    expect(actions).not.toContain("POST /voice/models/sensevoice-small-int8");
  });

  it("下载中显示进度条与「取消」；取消打到 /download 后缀的 DELETE", async () => {
    await mount({
      models: [
        {
          ...MODEL_BUILTIN,
          download: {
            state: "downloading",
            downloadedBytes: 1_000,
            totalBytes: 2_000,
          },
        },
      ],
    });
    expect(screen.getByRole("progressbar")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await vi.waitFor(() => {
      expect(actions).toContain(
        "DELETE /voice/models/sensevoice-small-int8/download",
      );
    });
  });

  it("检测报告：显示硬件、三段结论与可应用的建议", async () => {
    await mount();
    expect(await screen.findByText(/Test CPU · 12 核/)).toBeTruthy();
    expect(screen.getByText(/实测 7 次的中位实时率 0.08/)).toBeTruthy();
    // 听达标但想未测 → 建议仍是「只转文本」
    expect(screen.getByText(/建议：只转文本/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "应用推荐" }));
    await vi.waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    expect(saves[0]).toEqual({ mode: "transcribe", speakReplies: false });
  });

  it("测到 NVIDIA GPU 时提示「可接 GPU 服务」（探不到则完全不提）", async () => {
    await mount({
      report: {
        ...REPORT,
        hardware: { ...REPORT.hardware, gpu: "NVIDIA GeForce RTX 4060" },
      },
    });
    expect(await screen.findByText(/可接 GPU 服务/)).toBeTruthy();
    expect(screen.getByText(/RTX 4060/)).toBeTruthy();
  });

  it("没有 GPU 时不出现该提示（不摆空壳）", async () => {
    await mount();
    expect(await screen.findByText(/Test CPU · 12 核/)).toBeTruthy();
    expect(screen.queryByText(/可接 GPU 服务/)).toBeNull();
  });

  it("没测过时给一句说明与重新检测按钮（不留空白）", async () => {
    await mount({ report: null });
    expect(await screen.findByText(/还没检测过/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新检测" })).toBeTruthy();
  });

  it("选中的候选读不出名字时原样显示 id 并提示重选（配置漂移不藏起来）", async () => {
    await mount({
      settings: { ...SETTINGS, listen: { kind: "builtin", id: "ghost-model" } },
    });
    expect(
      await screen.findByText(/ghost-model（目录里已找不到，请重选）/),
    ).toBeTruthy();
  });
});
