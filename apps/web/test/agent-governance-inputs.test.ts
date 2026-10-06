import { instanceSettingsSchema } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import {
  governanceInputValues,
  parseAgentGovernanceInputs,
  selectAgentGovernanceSettings,
} from "../src/lib/agent-governance-settings";

const settings = () =>
  instanceSettingsSchema.parse({
    defaultModel: "",
    compactKeepMessages: 2,
    compactFallbackKeepMessages: 3,
  });

describe("公开治理表单输入与真实响应选择", () => {
  it("解析完整整数，保留两项独立目标与其余设置", () => {
    const selected = selectAgentGovernanceSettings(settings());
    const values = governanceInputValues(selected);
    values.compactKeepMessages = " 7 ";
    values.compactFallbackKeepMessages = "9";
    expect(parseAgentGovernanceInputs(values, true)).toEqual({
      ...selected,
      compactKeepMessages: 7,
      compactFallbackKeepMessages: 9,
      llmInfiniteRetry: true,
    });
  });

  it("小数、空值、越界和错误数字不会被parseInt截断后提交", () => {
    const selected = selectAgentGovernanceSettings(settings());
    for (const value of ["2.5", "", " ", "0", "-1", "10001", "2oops"]) {
      for (const key of [
        "compactKeepMessages",
        "compactFallbackKeepMessages",
      ] as const) {
        const values = governanceInputValues(selected);
        values[key] = value;
        expect(parseAgentGovernanceInputs(values, false)).toBeNull();
      }
    }
  });

  it("缺失或非法响应值如实拒绝，不填本地默认当已读取配置", () => {
    for (const key of [
      "compactKeepMessages",
      "compactFallbackKeepMessages",
      "subagentMaxDepth",
    ] as const) {
      const missing = settings();
      Reflect.deleteProperty(missing, key);
      expect(() => selectAgentGovernanceSettings(missing)).toThrow(
        "实例治理设置响应不完整",
      );
      const invalid = settings();
      invalid[key] = 0.5;
      expect(() => selectAgentGovernanceSettings(invalid)).toThrow(
        "实例治理设置响应不完整",
      );
    }
  });
});
