import type { SubAgent } from "deepagents";

import { createVideoGenerateTool } from "./tools/video-generate.js";

/**
 * 子代理清单：**agent 装配与「子智能体」页共用这一份**。
 *
 * 两处消费同一个来源，避免「界面写着有、跑起来没有」这类漂移：
 * - agent 装配：`deep-agent.ts` 的 `subagents: declaredSubAgentSpecs()`；
 * - 界面：`GET /api/agent/subagents` → 设置 →「子智能体」。
 *
 * 另有一个不由我们声明的分发工具 `task`（deepagents 内置），一并列进清单——前端
 * 「子代理目录」正是按这些工具名从事件流里推导运行条目的（见
 * `apps/web/src/lib/subagent-directory.ts`）。
 */

/** 视频生成子代理：可用性取决于有没有配视频供应商（描述里如实写）。 */
export function createVideoSubAgent(): SubAgent {
  return {
    name: "video_generate",
    description:
      "Generate a video based on a creative description. Video generation availability depends on provider configuration.",
    systemPrompt: `You are a video generation specialist. Given a description, generate a video using the generate_video tool and return the result.

If video generation is not available or fails, clearly explain the limitation.`,
    tools: [createVideoGenerateTool()],
  };
}

/** 面向界面的清单：我们声明的子代理（中文短名 + 工具名）。 */
export function listDeclaredSubAgents(): Array<{
  name: string;
  label: string;
  description: string;
  tools: string[];
}> {
  const spec = createVideoSubAgent();
  return [
    {
      name: spec.name,
      label: "视频生成",
      // 界面文案与 `spec.description` 分开：那一份是**写给模型看的**（派活依据），
      // 这一份是写给用户看的——同一句话当两用会逼用户读英文原文。
      description: "按描述生成视频；是否可用取决于有没有配置视频供应商。",
      tools: (spec.tools ?? []).map((tool) => tool.name),
    },
  ];
}

/** 装配用：直接给 deepagents 的 `subagents:` 数组（与上面同一份）。 */
export function declaredSubAgentSpecs(): SubAgent[] {
  return [createVideoSubAgent()];
}

/** 内置的子任务分发工具（不由我们声明，但会出现在工具表与事件流里）。 */
export const BUILTIN_SUBAGENT_DISPATCHER = {
  name: "task",
  label: "子任务分发",
  description:
    "deepagents 内置：把子任务派给某个子代理并回收结果（子代理名由入参指定）。",
} as const;
