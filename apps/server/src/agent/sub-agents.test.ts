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

  it("每条都带中文短名、模型可见的描述与工具名（界面不显示英文原文时才不空）", () => {
    for (const entry of listDeclaredSubAgents()) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.tools.length).toBeGreaterThan(0);
      // 工具名是**子代理内部挂的工具**（`generate_video`）；子代理自己对外暴露的名字是
      // `video_generate`（deepagents 把它当父工具派活，前端目录就盯这个名字）
      expect(entry.tools).toContain("generate_video");
    }
  });

  it("视频子代理的描述如实写明「取决于供应商配置」（可用性不是硬编码 true）", () => {
    const video = listDeclaredSubAgents().find(
      (entry) => entry.name === "video_generate",
    );
    expect(video?.description).toMatch(/provider configuration/i);
  });
});
