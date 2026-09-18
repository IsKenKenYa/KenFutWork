import { describe, expect, it } from "vitest";

import { declaredSubAgentSpecs, listDeclaredSubAgents } from "./sub-agents.js";

/**
 * 子智能体清单（设置 →「子智能体」页的内容来源）。
 *
 * 锁的是**同源**这件事：清单与 agent 装配（`deep-agent.ts` 的 `subagents:`）必须是同一份，
 * 否则界面会写出「有这个子代理」而真跑起来派不动——那类漂移在真机上极难看出。
 */
describe("子智能体清单", () => {
  it("装配用的 specs 与界面清单同源（同一批名字）", () => {
    const specs = declaredSubAgentSpecs();
    const listed = listDeclaredSubAgents();
    expect(specs.map((spec) => spec.name)).toEqual(
      listed.map((entry) => entry.name),
    );
    expect(listed.length).toBeGreaterThan(0);
  });

  it("每条都带中文短名、描述与工具名（界面不裸露英文原文与内部字段）", () => {
    for (const entry of listDeclaredSubAgents()) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.tools.length).toBeGreaterThan(0);
      // 界面描述是**给人看的**中文：不把写给模型的英文原文原样搬到设置页上
      expect(entry.description).toMatch(/[\u4e00-\u9fa5]/);
      // 工具名是**子代理内部挂的工具**（`generate_video`）；子代理自己对外暴露的名字是
      // `video_generate`（deepagents 把它当父工具派活，前端目录就盯这个名字）
      expect(entry.tools).toContain("generate_video");
    }
  });

  it("视频子代理：模型看到英文能力描述，界面看到中文说明且写明「取决于供应商配置」", () => {
    const spec = declaredSubAgentSpecs().find(
      (entry) => entry.name === "video_generate",
    );
    expect(spec?.description).toMatch(/provider configuration/i);

    const video = listDeclaredSubAgents().find(
      (entry) => entry.name === "video_generate",
    );
    expect(video?.description).toMatch(/取决于.*供应商/);
  });
});
