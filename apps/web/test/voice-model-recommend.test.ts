import type { VoiceModelCandidate } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";

import { recommendVoiceModels } from "../src/components/workbench/zcode/settings/VoiceSection";

function candidate(
  overrides: Partial<VoiceModelCandidate> & {
    id: string;
    segment: VoiceModelCandidate["segment"];
  },
): VoiceModelCandidate {
  return {
    label: overrides.id,
    kind: "builtin",
    location: "cpu",
    sizeBytes: 0,
    needsDownload: false,
    download: { state: "ready", downloadedBytes: 0, totalBytes: 0 },
    ...overrides,
  } as VoiceModelCandidate;
}

describe("每段推荐模型", () => {
  it("听/说取本机离线，想取在线实例", () => {
    const picked = recommendVoiceModels([
      candidate({ id: "asr-local", segment: "listen" }),
      candidate({ id: "asr-online", segment: "listen", kind: "instance" }),
      candidate({ id: "llm-local", segment: "think" }),
      candidate({ id: "llm-online", segment: "think", kind: "instance" }),
      candidate({ id: "tts-local", segment: "speak" }),
    ]);
    expect(picked.listen?.id).toBe("asr-local");
    expect(picked.think?.id).toBe("llm-online");
    expect(picked.speak?.id).toBe("tts-local");
  });

  it("首选来源缺席时退回同段第一项（不因为偏好空着就漏段）", () => {
    const picked = recommendVoiceModels([
      candidate({ id: "asr-online", segment: "listen", kind: "instance" }),
    ]);
    expect(picked.listen?.id).toBe("asr-online");
  });

  it("硬缺失（unavailableReason）不参与推荐", () => {
    const picked = recommendVoiceModels([
      candidate({
        id: "asr-dead",
        segment: "listen",
        unavailableReason: "该供应商实例已停用",
      }),
    ]);
    expect(picked.listen).toBeUndefined();
  });

  it("全部离线也照样推荐（不要求必须装过一次）", () => {
    const picked = recommendVoiceModels([
      candidate({ id: "asr-local", segment: "listen" }),
    ]);
    expect(picked.listen?.id).toBe("asr-local");
  });
});
