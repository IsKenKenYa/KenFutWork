import { expect, it } from "vitest";

import type { PromptCompositionContext } from "../../kernel/types.js";
import { createRulesPromptSection } from "./prompt-sections.js";

const base: PromptCompositionContext = { preset: "code" };

it("插件钩子上下文进入规则段，排在用户规则之后", async () => {
  const section = createRulesPromptSection({ pluginFragments: () => [] });
  const text = await section.resolve({
    ...base,
    userRulesFragment: ["用户规则：先读 README。"],
    pluginHookContext: ["插件规则：生成前先确认 credits。"],
  });
  expect(text).toContain("用户规则：先读 README。");
  expect(text).toContain("## 插件钩子上下文");
  expect(text).toContain("插件规则：生成前先确认 credits。");
  expect(text?.indexOf("用户规则")).toBeLessThan(
    text?.indexOf("插件钩子上下文") ?? -1,
  );
});

it("没有钩子上下文时不出现空段", async () => {
  const section = createRulesPromptSection({ pluginFragments: () => [] });
  expect(await section.resolve(base)).toBeNull();
});
