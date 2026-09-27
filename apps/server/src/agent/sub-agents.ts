import type { SubAgent } from "deepagents";

import type { AvailableVideoModel } from "../generation/types.js";
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
export function createVideoSubAgent(
  availableVideoModels: AvailableVideoModel[] = [],
): SubAgent {
  return {
    name: "video_generate",
    description:
      "Generate a video based on a creative description. Video generation availability depends on provider configuration.",
    systemPrompt: `You are a video generation specialist. Given a description, generate a video using the generate_video tool and return the result.

If video generation is not available or fails, clearly explain the limitation.`,
    tools: [createVideoGenerateTool({ availableModels: availableVideoModels })],
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
      // 只写标签 + 一个必要前提（「需配供应商」是用户要提前知道的事实，不是解释句）
      description: "按描述生成视频 · 需配视频供应商",
      tools: (spec.tools ?? []).map((tool) => tool.name),
    },
  ];
}

/** 用户自定义子智能体（工作区设置 `subagents` 列，设置页可增删）。 */
export interface CustomSubagentSpec {
  name: string;
  label: string;
  /** 派活依据（模型据此决定何时把子任务交给它）。 */
  description: string;
  systemPrompt: string;
}

/** 内置声明的名字（自定义项与它撞名时拒掉，内置优先——界面与装配不能漂移）。 */
function builtinNames(): Set<string> {
  return new Set(listDeclaredSubAgents().map((entry) => entry.name));
}

/** 自定义项 → deepagents SubAgent（无专用工具，角色全靠 systemPrompt）。 */
function toSubAgent(spec: CustomSubagentSpec): SubAgent {
  return {
    name: spec.name,
    description: spec.description,
    systemPrompt: spec.systemPrompt,
  };
}

/**
 * 装配用清单：内置声明 + 用户自定义。
 *
 * 自定义项与内置撞名时**丢弃并告警**（fail loud 在日志，不静默让两个同名并存——
 * deepagents 按 name 索引，撞名是未定义行为）。
 */
export function declaredSubAgentSpecs(
  availableVideoModels: AvailableVideoModel[] = [],
  custom: CustomSubagentSpec[] = [],
): SubAgent[] {
  const reserved = builtinNames();
  const specs: SubAgent[] = [createVideoSubAgent(availableVideoModels)];
  for (const entry of custom) {
    if (reserved.has(entry.name)) {
      console.warn(
        `[sub-agents] 自定义子智能体「${entry.name}」与内置声明撞名，已忽略。`,
      );
      continue;
    }
    specs.push(toSubAgent(entry));
  }
  return specs;
}

/**
 * 设置页用的自定义清单：**剔除**与内置撞名的项后原样返回（撞名的不会装配，
 * 界面也不能显示成「会生效」）。解析（形状清洗/去重/截断）已在 settings-service 做。
 */
export function listCustomSubAgents(
  custom: CustomSubagentSpec[] = [],
): CustomSubagentSpec[] {
  const reserved = builtinNames();
  return custom.filter((entry) => !reserved.has(entry.name));
}

/** 内置的子任务分发工具（不由我们声明，但会出现在工具表与事件流里）。 */
export const BUILTIN_SUBAGENT_DISPATCHER = {
  name: "task",
  label: "子任务分发",
  description: "派子任务给子代理",
} as const;
