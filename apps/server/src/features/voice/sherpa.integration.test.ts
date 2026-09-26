import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { decodeWav, floatToPcm16Array } from "./audio.js";
import { resolveBuiltinModelDir } from "./builtin-models.js";
import { SENSE_VOICE, SILERO_VAD_MODEL } from "./catalog.js";
import { createVoiceModelStore } from "./model-store.js";
import { createSherpaProvider } from "./providers/sherpa.js";

/**
 * 真机验收（integration，默认跳过）：**真下载两百兆模型 + 真中文音频**跑一遍
 * 「下载 → 校验 → 加载 → 转写 → 切句」，证明内置路径端到端可用。
 *
 * 为什么必须有这一层：单测拿桩模块跑，能锁逻辑但证明不了
 * 「配置字段名 sherpa 认」——实测过 Vad 对坏路径**不抛错**，
 * 写错字段名只会静默给空结果，桩模块永远发现不了。
 *
 * 跑法（首次会下载约 228MB 到 `~/.kenfutwork/models`，之后复用）：
 *   KENFUTWORK_VOICE_REAL_MODEL=1 pnpm exec vitest run --root apps/server \
 *     src/features/voice/sherpa.integration.test.ts
 *
 * 样本用 sherpa 官方测试音频 `test_wavs/zh.wav`（仅本地缓存，不入库）。
 * 断言取**宽松但有效**的口径：非空 + 含汉字 + 含句读（`use_itn=1` 的作用）+ RTF 上界；
 * 不硬编码具体句子（换模型/换版本会变，钉死句子等于给自己埋定时炸弹）。
 */

const enabled = process.env.KENFUTWORK_VOICE_REAL_MODEL === "1";
const modelsRoot =
  process.env.KENFUTWORK_VOICE_MODELS_ROOT ??
  join(homedir(), ".kenfutwork", "models");
const SAMPLE_URL =
  "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/test_wavs/zh.wav";

async function ensureSampleWav(): Promise<Uint8Array> {
  const cachePath = join(tmpdir(), "kenfutwork-voice-sample-zh.wav");
  if (!existsSync(cachePath)) {
    const response = await fetch(SAMPLE_URL, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`样本下载失败：HTTP ${response.status}`);
    }
    await writeFile(cachePath, Buffer.from(await response.arrayBuffer()));
  }
  return new Uint8Array(await readFile(cachePath));
}

describe.skipIf(!enabled)("内置 Speech-to-Text 真机（integration）", () => {
  it("下载并校验 228MB 模型 → 转写真实中文音频 → 切句掐掉首尾静音", async () => {
    const store = createVoiceModelStore({ modelsRoot });
    await mkdir(modelsRoot, { recursive: true });

    for (const modelId of [SENSE_VOICE.id, SILERO_VAD_MODEL.id]) {
      if ((await store.getState(modelId)).state === "ready") {
        continue;
      }
      await store.start(modelId);
      const settled = Date.now() + 10 * 60 * 1000;
      for (;;) {
        const state = await store.getState(modelId);
        if (state.state === "ready") break;
        if (state.state === "missing") {
          throw new Error(`${modelId} 下载失败：${state.error ?? "未知原因"}`);
        }
        if (Date.now() > settled) {
          throw new Error(`${modelId} 下载超时`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }

    const listenDir = resolveBuiltinModelDir(modelsRoot, SENSE_VOICE.id);
    const vadDir = resolveBuiltinModelDir(modelsRoot, SILERO_VAD_MODEL.id);
    const provider = createSherpaProvider({
      models: {
        asr: {
          model: join(listenDir, SENSE_VOICE.layout.model),
          tokens: join(listenDir, SENSE_VOICE.layout.tokens),
        },
        vad: { model: join(vadDir, SILERO_VAD_MODEL.layout.model) },
      },
    });

    const ready = await provider.transcriber?.ready();
    expect(ready?.ok, ready?.reason).toBe(true);
    const vadReady = await provider.vad?.ready();
    expect(vadReady?.ok, vadReady?.reason).toBe(true);

    const wav = await ensureSampleWav();
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(16_000);

    const started = Date.now();
    const { text } = (await provider.transcriber?.transcribe(wav)) as {
      text: string;
    };
    const seconds = (Date.now() - started) / 1000;
    const audioSeconds = decoded.samples.length / decoded.sampleRate;
    const rtf = seconds / audioSeconds;

    // 真的转出中文了（不是空串、不是乱码）
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/[\u4e00-\u9fff]/);
    // use_itn=1 的可见效果：口语数字转书写、带句读
    expect(text).toMatch(/[。，？！]/);
    // 本机实测约 0.68；上界放到 2.0（规划 §6 的「差」档）不卡死慢机器
    expect(rtf).toBeLessThan(2);
    console.log(
      `[voice] 实测：${audioSeconds.toFixed(2)}s 音频 → 「${text}」（${seconds.toFixed(2)}s，RTF=${rtf.toFixed(3)}）`,
    );

    // VAD 真切句：样本带前导静音，首段起点必须明显晚于 0
    const { segments } = (provider.vad?.segment(
      floatToPcm16Array(decoded.samples),
    ) ?? { segments: [] }) as { segments: Array<[number, number]> };
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0]?.[0]).toBeGreaterThan(0);
    for (const [start, end] of segments) {
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(decoded.samples.length);
    }
  }, 900_000);
});
