/**
 * 子代理定义注册表（DEC-14/DEC-16）：**声明、界面清单、派发过滤共用这一份**。
 *
 * 形态对齐 dsh 的能力缝：Definition（本文件）+ Provider（in-process 子代理运行，
 * 见 `subagent-tools.ts` 的 childRunner；v2 增独立 run/跨产品 provider）+
 * Consumer（task / task_background 工具）。
 *
 * 深度治理（DEC-17）：子代理经 `createAgent` 组装，**不挂任何派发工具**——
 * 深度上限 1 是结构性的，不是提示词约定。
 */

export interface SubagentDefinition {
  /** 派发名（task / task_background 的 `subagent_type`）。 */
  name: string;
  /** 用户可见短名（设置页「子智能体」与子代理目录）。 */
  label: string;
  /** 写给模型看的派活依据：何时该派、怎么用。 */
  description: string;
  /** 生效模式：design=画布项目 / code=工作目录项目 / shared=两模式都可派。 */
  preset: "design" | "code" | "shared";
  /** 只读定义：plan 执行模式白名单的判据（DEC-17）。 */
  readOnly: boolean;
  systemPrompt: string;
  /**
   * 专用工具：从父 run 的工具面按名拾取（generate_image 等）。
   * 只读文件工具（ls/read_file/glob/grep）不在这里声明——经
   * {@link SubagentDefinition.filesystemTools} 挂白名单中间件。
   */
  tools: string[];
  /**
   * 文件工具白名单（deepagents createFilesystemMiddleware）。**列了就挂中间件，
   * 且 execute 不在可选项里**——只读子代理的执行能力是结构性的「没有」。
   */
  filesystemTools?: ReadonlyArray<"ls" | "read_file" | "glob" | "grep">;
}

export const SUBAGENT_DEFINITIONS: readonly SubagentDefinition[] = [
  {
    name: "explore",
    label: "代码调研",
    description:
      "只读代码调研：在项目工作目录里定位代码、追踪调用、评估改动影响面。" +
      "当任务需要先弄清「现状是什么/代码在哪」再动手，或问题涉及多个文件时派它；" +
      "它不修改任何文件，返回结论与关键文件路径。",
    preset: "code",
    readOnly: true,
    systemPrompt:
      "你是代码调研专员。在项目工作目录里做**只读**调研：定位实现、追踪调用链、" +
      "梳理数据流。不修改、不创建、不删除任何文件，不执行命令。返回：结论、" +
      "关键文件路径与行号、以及与任务直接相关的事实。不要展开与任务无关的泛泛介绍。",
    tools: ["project_search"],
    filesystemTools: ["ls", "read_file", "glob", "grep"],
  },
  {
    name: "review",
    label: "代码审查",
    description:
      "只读代码审查：对照工作目录的当前变更（影子 git 检查点/差异工具）审查质量、" +
      "找 bug 与风险，产出问题清单。在用户要求 review/检查改动，或大改完成后自查时派它。",
    preset: "code",
    readOnly: true,
    systemPrompt:
      "你是代码审查专员。只读审查当前工作目录的变更：用 diff/preview 工具看改动，" +
      "必要时读相关源码。不修改任何文件。返回按严重程度排序的问题清单：" +
      "[严重度] 文件:行号 — 问题 — 建议。没有问题就明说没有。",
    tools: ["project_search", "diff_files", "preview_file"],
    filesystemTools: ["ls", "read_file", "glob", "grep"],
  },
  {
    name: "planner",
    label: "规划拆解",
    description:
      "画布项目的大任务规划：先勘察画布/项目现状，产出有序执行计划（不执行）。" +
      "当用户需求涉及多个生成物或多个步骤、先对齐计划能省返工时派它；小任务不要派。",
    preset: "design",
    readOnly: true,
    systemPrompt:
      "你是规划专员。用 inspect_canvas/project_search 勘察现状后，把需求拆成" +
      "有序、可执行的计划：每步一句话说清做什么、用什么能力、验收标准是什么。" +
      "你不执行任何生成或修改，只返回计划文本。",
    tools: ["inspect_canvas", "project_search"],
  },
  {
    name: "batch_image",
    label: "批量出图",
    description:
      "批量图片生成：把一组图片需求逐张调 generate_image 生成并落画布。" +
      "当一次需要 2 张以上的图（多方案对比、系列素材、逐页配图）时派它——" +
      "长耗时的生成轮询隔离在子代理里，主对话保持画布编排视野。",
    preset: "design",
    readOnly: false,
    systemPrompt:
      "你是批量出图专员。按收到的图片清单逐张调 generate_image（每张都写清楚" +
      "画面描述），全部完成后返回逐张结果（成功/失败与原因）。单张失败不要中断" +
      "整批，继续生成其余图片。",
    tools: ["generate_image"],
  },
  {
    name: "video_generate",
    label: "视频生成",
    description:
      "视频生成：按创意描述调 generate_video 生成视频并落画布。" +
      "生成耗时长（轮询数分钟），适合派给子代理等待结果。",
    preset: "shared",
    readOnly: false,
    systemPrompt:
      "你是视频生成专员。用 generate_video 按描述生成视频并返回结果。" +
      "若视频生成不可用或失败，如实说明原因。",
    tools: ["generate_video"],
  },
];

/** 按 run 的 preset 过滤：shared 恒在，design/code 各取本模式定义。 */
export function resolveSubagentDefinitions(
  preset: "design" | "code",
): SubagentDefinition[] {
  return SUBAGENT_DEFINITIONS.filter(
    (def) => def.preset === "shared" || def.preset === preset,
  );
}

export function findSubagentDefinition(
  preset: "design" | "code",
  name: string,
): SubagentDefinition | undefined {
  return resolveSubagentDefinitions(preset).find((def) => def.name === name);
}

/** 面向界面的清单（设置页「子智能体」与 GET /api/agent/subagents）。 */
export function listSubagentDefinitions(): Array<{
  name: string;
  label: string;
  description: string;
  tools: string[];
}> {
  return SUBAGENT_DEFINITIONS.map((def) => ({
    name: def.name,
    label: def.label,
    description: def.description,
    tools: [...def.tools, ...(def.filesystemTools ?? [])],
  }));
}

/** 面向界面的派发工具说明（GET /api/agent/subagents 的 builtin 段）。 */
export const SUBAGENT_DISPATCH_TOOLS = [
  {
    name: "task",
    label: "子任务派发（前台）",
    description:
      "把子任务派给某个子代理并等待结果；多个独立任务可同一条消息并行派发。",
  },
  {
    name: "task_background",
    label: "子任务派发（后台）",
    description: "把子任务放到后台执行并立即返回；完成后以系统通知送达。",
  },
  {
    name: "task_output",
    label: "后台任务查询",
    description: "按 taskId 查询后台任务状态与结果，或不带参数列出全部任务。",
  },
] as const;
