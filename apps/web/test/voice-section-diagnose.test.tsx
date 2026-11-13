import type {
  VoiceDiagnoseReport,
  VoiceModelCandidate,
  VoiceSettings,
} from "@kenfutwork/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type VoiceDataClient,
  VoiceSection,
} from "../src/components/workbench/zcode/settings/VoiceSection.js";

/**
 * 设置 → 语音（code-ui 分区）的回归锁：
 * 1. **不可用要原样透出原因**——曾经统一写「未实测」，把「模型没下载」伪装成
 *    「还没测」，用户点多少次「重新检测」都还是「未实测」；
 * 2. **未下载的内置模型给下载入口**——没有入口就永远测不出朗读/转换的读数；
 * 3. 「重新检测」是真的发 POST 并刷新报告。
 */

const SETTINGS: VoiceSettings = {
  mode: "loop",
  listen: { kind: "builtin", id: "sensevoice-small-int8" },
  think: { kind: "instance", id: "inst-1", model: "GLM-5.3-Flash" },
  speak: { kind: "builtin", id: "kokoro-multi-lang" },
  speakReplies: false,
};

const LISTEN_MODEL: VoiceModelCandidate = {
  id: "sensevoice-small-int8",
  segment: "listen",
  label: "SenseVoice Small（int8）",
  kind: "builtin",
  location: "cpu",
  sizeBytes: 239_549_735,
  needsDownload: true,
  download: {
    state: "ready",
    downloadedBytes: 239_549_735,
    totalBytes: 239_549_735,
  },
};

const SPEAK_MODEL: VoiceModelCandidate = {
  id: "kokoro-multi-lang",
  segment: "speak",
  label: "Kokoro 多语版（82M）",
  kind: "builtin",
  location: "cpu",
  sizeBytes: 401_227_209,
  needsDownload: true,
  download: { state: "missing", downloadedBytes: 0, totalBytes: 401_227_209 },
};

const THINK_MODEL: VoiceModelCandidate = {
  id: "inst-1",
  segment: "think",
  label: "aiping / GLM-5.3-Flash",
  kind: "instance",
  location: "remote",
  model: "GLM-5.3-Flash",
  sizeBytes: 0,
  needsDownload: false,
  download: { state: "ready", downloadedBytes: 0, totalBytes: 0 },
};

const REPORT: VoiceDiagnoseReport = {
  hardware: {
    cpuModel: "Test CPU",
    cpuCores: 12,
    totalMemoryBytes: 16 * 1024 ** 3,
    platform: "win32",
  },
  listen: {
    state: "measured",
    summary: "比实时快 3.2 倍 首载 4.2s",
    listen: { samples: 1, rtfMedian: 0.31, modelLoadMs: 4_200 },
  },
  think: { state: "measured", summary: "首字 2.26s · 18 tokens/s" },
  speak: {
    state: "unavailable",
    summary: "「说」模型文件缺失：C:\\models\\kokoro-multi-lang\\model.onnx",
  },
  measuredAt: "2026-11-12T00:00:00.000Z",
};

function stubClient(options: {
  report?: VoiceDiagnoseReport | null;
  diagnoseReport?: VoiceDiagnoseReport;
  models?: VoiceModelCandidate[];
}) {
  const calls: Array<{ method: string; path: string }> = [];
  let models = options.models ?? [LISTEN_MODEL, THINK_MODEL, SPEAK_MODEL];
  const client: VoiceDataClient = {
    async request<T>(path: string, body?: unknown): Promise<T> {
      calls.push({ method: body === undefined ? "GET" : "POST", path });
      if (path === "/api/voice/settings") {
        return { settings: SETTINGS } as T;
      }
      if (path === "/api/voice/models") {
        return { models } as T;
      }
      if (path.endsWith("/download")) {
        models = models.map((model) =>
          model.id === SPEAK_MODEL.id
            ? {
                ...model,
                download: {
                  state: "downloading" as const,
                  downloadedBytes: 100,
                  totalBytes: 400,
                },
              }
            : model,
        );
        return {
          model: models.find((model) => model.id === SPEAK_MODEL.id),
        } as T;
      }
      if (path === "/api/voice/diagnose") {
        return { report: options.report ?? REPORT } as T;
      }
      throw new Error(`unexpected ${path}`);
    },
    async requestWithSignal<T>(): Promise<T> {
      calls.push({ method: "POST", path: "/api/voice/diagnose" });
      return { report: options.diagnoseReport ?? REPORT } as T;
    },
    async putRequest<T>(): Promise<T> {
      return { settings: SETTINGS } as T;
    },
    async deleteRequest<T>(): Promise<T> {
      throw new Error("not used");
    },
  };
  return { client, calls };
}

afterEach(() => {
  cleanup();
});

describe("设置 → 语音（code-ui）", () => {
  it("不可用段显示真实原因，而不是一律「未实测」", async () => {
    const { client } = stubClient({});
    render(<VoiceSection client={client} />);
    expect(await screen.findByText(/模型文件缺失/)).toBeTruthy();
    // 转换模型已经实测：显示读数
    expect(screen.getByText(/比实时快 3\.2 倍/)).toBeTruthy();
  });

  it("选中的内置模型未下载：行上出现下载按钮，点了打 /download 并进入下载态", async () => {
    const { client, calls } = stubClient({});
    render(<VoiceSection client={client} />);
    const download = await screen.findByRole("button", {
      name: /下载 383 MB/,
    });
    fireEvent.click(download);
    await vi.waitFor(() => {
      expect(calls).toContainEqual({
        method: "POST",
        path: "/api/voice/models/kokoro-multi-lang/download",
      });
    });
    // 进度从响应回来：下载态按钮改文案（百分比来自 downloadedBytes/totalBytes）
    expect(
      await screen.findByRole("button", { name: /取消 25%/ }),
    ).toBeTruthy();
  });

  it("重新检测发 POST 并换上新的报告", async () => {
    const { client, calls } = stubClient({
      diagnoseReport: {
        ...REPORT,
        speak: { state: "measured", summary: "首包 0.62s · 比实时快 2.4 倍" },
      },
    });
    render(<VoiceSection client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "重新检测" }));
    expect(await screen.findByText(/首包 0\.62s/)).toBeTruthy();
    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/voice/diagnose",
    });
  });
});
