import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { LoomicAgentFactory } from "../agent/deep-agent.js";
import type { ServerEnv } from "../config/env.js";
import { createAdminPlugin } from "../features/admin/plugin.js";
import { createAgentModesPlugin } from "../features/agent-modes/plugin.js";
import { createAgentRunsPlugin } from "../features/agent-runs/plugin.js";
import { createAuthPlugin } from "../features/auth/plugin.js";
import { createBlobPlugin } from "../features/blob/plugin.js";
import { createViewerPlugin } from "../features/bootstrap/plugin.js";
import { brandKitPlugin } from "../features/brand-kit/plugin.js";
import { createCanvasPlugin } from "../features/canvas/plugin.js";
import { createChatPlugin } from "../features/chat/plugin.js";
import { createCodeToolsPlugin } from "../features/code-tools/plugin.js";
import { createCreditsPlugin } from "../features/credits/plugin.js";
import { createGenerationPlugin } from "../features/generation/plugin.js";
import type { JobService } from "../features/jobs/job-service.js";
import { createJobsPlugin } from "../features/jobs/plugin.js";
import { createMcpPlugin } from "../features/mcp/plugin.js";
import { createModelProvidersPlugin } from "../features/model-providers/plugin.js";
import type { PaymentService } from "../features/payments/payment-service.js";
import { createPaymentsPlugin } from "../features/payments/plugin.js";
import { createPermissionsPlugin } from "../features/permissions/plugin.js";
import { persistencePlugin } from "../features/persistence/plugin.js";
import {
  createPluginsPlugin,
  type PluginCatalogEntry,
} from "../features/plugins/plugin.js";
import { createProjectsPlugin } from "../features/projects/plugin.js";
import { createQueuePlugin } from "../features/queue/plugin.js";
import { createSearchPlugin } from "../features/search/plugin.js";
import { createSettingsPlugin } from "../features/settings/plugin.js";
import { createSkillsPlugin } from "../features/skills/plugin.js";
import { createUploadsPlugin } from "../features/uploads/plugin.js";
import { createUsagePlugin } from "../features/usage/plugin.js";
import type { KernelEvents, PluginDefinition } from "../kernel/types.js";
import type { ConnectionManager } from "../ws/connection-manager.js";

/**
 * server profile（§4.9）：HTTP 进程的插件清单——唯一属主。
 * 新增 feature 插件只改这里一行（P8 起 app.ts 不再维护清单）。
 */

export interface ServerProfileDeps {
  connectionManager: ConnectionManager;
  events: KernelEvents;
  credentialEnv: { credentialSecret?: string };
  env: ServerEnv;
  agentFactory?: LoomicAgentFactory;
  agentModel?: BaseLanguageModel | string;
  mockEventDelayMs?: number;
  /** overrides 直填的条件装配插件需感知注入实例（enabled 判定，保持历史行为）。 */
  overrideJobs?: JobService;
  overridePayments?: PaymentService;
  /** GitHub token（可选）：插件从仓库安装时提升匿名速率上限。 */
  githubToken?: string;
}

/** 插件市场目录：与清单同源维护（真实注册项的说明 + 能力声明，供导出用）。 */
export const PLUGIN_CATALOG: PluginCatalogEntry[] = [
  {
    name: "model-providers",
    title: "BYOK 供应商",
    description:
      "添加你自己的模型实例（OpenAI 兼容 / Anthropic / Gemini / 图像 / 视频协议），Key 加密保存。",
    capabilities: ["llm"],
  },
  {
    name: "agent-runs",
    title: "Agent 运行时",
    description: "任务编排、流式输出、子代理与工具调用。",
    capabilities: ["agents", "tools"],
  },
  {
    name: "permissions",
    title: "权限策略",
    description: "危险工具三档审批（默认 / 自动放行 / 完全访问）。",
    capabilities: ["tools"],
  },
  {
    name: "agent-modes",
    title: "执行模式",
    description: "会话级 Code / Design 与 agent / plan 模式。",
    capabilities: [],
  },
  {
    name: "search",
    title: "联网搜索",
    description: "web_search 工具，为 Agent 接入实时信息。",
    capabilities: ["tools"],
  },
  {
    name: "mcp",
    title: "MCP 接入",
    description: "连接 MCP server，工具自动进入统一注册表。",
    capabilities: ["tools"],
  },
  {
    name: "usage",
    title: "用量统计",
    description: "Agent 与直连生成的 token/成本计量。",
    capabilities: [],
  },
  {
    name: "canvas",
    title: "画布（Design）",
    description: "无限画布创作、品牌套件与图像/视频生成。",
    capabilities: ["tools"],
  },
  {
    name: "skills",
    title: "技能",
    description: "SKILL.md 技能发现与市场。",
    capabilities: ["tools"],
  },
  {
    name: "plugin-registry",
    title: "插件市场",
    description:
      "安装第三方插件（dsh bundle / 本项目 bundle），安装前过兼容性门禁，支持导入导出。",
    capabilities: [],
  },
];

export function serverProfile(deps: ServerProfileDeps): PluginDefinition[] {
  return [
    persistencePlugin,
    createQueuePlugin(),
    createBlobPlugin(),
    createAuthPlugin(),
    brandKitPlugin,
    createCreditsPlugin(),
    createViewerPlugin(),
    createCanvasPlugin(),
    createChatPlugin(),
    createSettingsPlugin(),
    createUploadsPlugin(),
    createProjectsPlugin(),
    createJobsPlugin({
      ...(deps.overrideJobs ? { injected: deps.overrideJobs } : {}),
    }),
    createPaymentsPlugin({
      ...(deps.overridePayments ? { injected: deps.overridePayments } : {}),
    }),
    createSkillsPlugin(),
    createUsagePlugin(),
    createPermissionsPlugin({ events: deps.events }),
    createAgentModesPlugin(),
    createCodeToolsPlugin(),
    createMcpPlugin(),
    createSearchPlugin(),
    createModelProvidersPlugin({ credentialEnv: deps.credentialEnv }),
    createGenerationPlugin({ env: deps.env }),
    createAdminPlugin(),
    createPluginsPlugin({
      builtinCatalog: PLUGIN_CATALOG,
      ...(deps.githubToken ? { githubToken: deps.githubToken } : {}),
    }),
    createAgentRunsPlugin({
      connectionManager: deps.connectionManager,
      events: deps.events,
      // DEC-1 事件缝：pre-step 改写权交给事件监听器（执行模式指令注入等）
      emitPreStep: (payload) => deps.events.emitPreStep(payload),
      ...(deps.agentFactory ? { agentFactory: deps.agentFactory } : {}),
      ...(deps.agentModel ? { agentModel: deps.agentModel } : {}),
      ...(deps.mockEventDelayMs === undefined
        ? {}
        : { mockEventDelayMs: deps.mockEventDelayMs }),
    }),
  ];
}
