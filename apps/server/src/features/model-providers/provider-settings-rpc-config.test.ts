import { describe, expect, it } from "vitest";
import type { ProviderPreset } from "./models-dev-snapshot.js";
import { codeUiTemplateConfig } from "./provider-settings-rpc-config.js";

function preset(id: string): ProviderPreset {
  return {
    id,
    name: id,
    env: [],
    models: [{ id: "chat-model", name: "Chat", capability: "chat" }],
  };
}

describe("模板内置 logo 映射（key 必须存在于移植侧 ProviderLogo 资产表）", () => {
  it("有已登记素材的品牌模板携带 builtin logo", () => {
    const expectations: Array<[string, string]> = [
      ["anthropic", "anthropic"],
      ["openai", "openai"],
      ["deepseek", "deepseek"],
      ["xai", "xai"],
      ["openrouter", "openrouter"],
      ["zai", "zai"],
      ["zai-coding-plan", "zai"],
      ["zhipuai", "bigmodel"],
      ["zhipuai-coding-plan", "bigmodel"],
      ["moonshotai", "moonshot-kimi"],
      ["moonshotai-cn", "moonshot-kimi"],
      ["kimi-for-coding", "moonshot-kimi"],
      ["minimax", "minimax"],
      ["minimax-cn", "minimax"],
      ["minimax-coding-plan", "minimax"],
      ["minimax-cn-coding-plan", "minimax"],
    ];
    for (const [id, key] of expectations) {
      expect(codeUiTemplateConfig(preset(id)).logo).toEqual({
        type: "builtin",
        key,
      });
    }
  });

  it("没有已登记素材的模板不带 logo，回落通用图标，不伪造素材 key", () => {
    for (const id of [
      "google",
      "groq",
      "cohere",
      "deepinfra",
      "mistral",
      "perplexity",
      "siliconflow",
      "siliconflow-cn",
      "stepfun",
      "stepfun-ai",
      "stepfun-step-plan",
      "stepfun-ai-step-plan",
      "volcengine",
      "volcengine-coding-plan",
    ]) {
      expect(codeUiTemplateConfig(preset(id)).logo).toBeUndefined();
    }
  });

  it("logo 不改变模板的其余配置投影", () => {
    const config = codeUiTemplateConfig(preset("anthropic"));
    expect(config.group).toBe("standard-personal");
    expect(config.access).toEqual({ type: "api-key" });
    expect(config.api).toEqual({
      type: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });
    expect(config.personalModelIds).toEqual(["chat-model"]);
  });
});
