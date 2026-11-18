import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { findBuiltinModel } from "../catalog.js";
import { createLlamafileThinkProvider } from "./llamafile.js";

/**
 * 离线「想」档真机验收（默认 skipped；要真实模型与真实进程）：
 *
 *   KENFUTWORK_VOICE_REAL_LLM=1 pnpm exec vitest run --root apps/server \
 *     src/features/voice/providers/llamafile.integration.test.ts
 *
 * 前置：先在「设置 → 语音」点一次「下载」（792MB，落 `<modelsRoot>/qwen3-0.6b-llamafile/`），
 * 或用 `KENFUTWORK_VOICE_MODELS_ROOT` 指向已放好模型文件的目录。
 *
 * 断言的是**行为**而不是实现：能拉起、能改写、改写结果非空且不丢原意关键词、
 * 首 token 延迟是一个正数。首次调用含模型载入，故这里只给宽上界（慢机器也过）。
 */
const enabled = process.env.KENFUTWORK_VOICE_REAL_LLM === "1";
const modelsRoot =
  process.env.KENFUTWORK_VOICE_MODELS_ROOT ??
  join(homedir(), ".kenfutwork", "models");

describe.skipIf(!enabled)("离线「想」档：llamafile 真机", () => {
  it("就位 → 拉起服务 → 改写口述 → 首 token 读数", async () => {
    const model = findBuiltinModel("qwen3-0.6b-llamafile");
    expect(model).toBeTruthy();
    const file = join(modelsRoot, model?.id ?? "", model?.layout.model ?? "");
    expect(
      existsSync(file),
      `模型文件不存在：${file}（先在设置页下载，或设 KENFUTWORK_VOICE_MODELS_ROOT）`,
    ).toBe(true);

    const provider = createLlamafileThinkProvider({
      modelsRoot,
      modelId: "qwen3-0.6b-llamafile",
    });
    try {
      expect(await provider.ready()).toEqual({ ok: true });

      const refined = await provider.refine({
        text: "把首页那个按钮改蓝一点",
        recentMessages: [{ role: "assistant", content: "刚生成了首页草稿。" }],
      });
      expect(refined.length).toBeGreaterThan(4);
      // 只补全不改写：原意关键词应当还在（「按钮」「蓝」至少留一个）
      expect(/按钮|蓝/.test(refined)).toBe(true);

      const probe = await provider.probe();
      expect(probe.ttftSeconds).toBeGreaterThan(0);
      expect(probe.ttftSeconds).toBeLessThan(120);
    } finally {
      await provider.dispose();
    }
  }, 300_000);
});
