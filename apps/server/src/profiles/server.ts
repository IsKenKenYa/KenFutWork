import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { KenFutWorkAgentFactory } from "../agent/deep-agent.js";
import type { AgentRuntimeProvider } from "../agent/provider-contract.js";
import type { ServerEnv } from "../config/env.js";
import { isDesktopRuntime } from "../desktop/runtime.js";
import { createAgentRunsPlugin } from "../features/agent-runs/plugin.js";
import { createBlobPlugin } from "../features/blob/plugin.js";
import { brandKitPlugin } from "../features/brand-kit/plugin.js";
import { createBrowserPlugin } from "../features/browser/plugin.js";
import { createCadPlugin } from "../features/cad/plugin.js";
import { createCanvasAssetLocationsPlugin } from "../features/canvas/asset-locations-plugin.js";
import { createCanvasPublicationRelayPlugin } from "../features/canvas/generation-publication-relay.js";
import {
  createCanvasPlugin,
  createCanvasToolsPlugin,
} from "../features/canvas/plugin.js";
import { createChatPlugin } from "../features/chat/plugin.js";
import { createRealtimePlugin } from "../features/chat/realtime-plugin.js";
import { createCheckpointsPlugin } from "../features/checkpoints/plugin.js";
import { createCodeGitPlugin } from "../features/code-git/plugin.js";
import { createCodeSubagentsPlugin } from "../features/code-subagents/plugin.js";
import { createCodeTerminalPlugin } from "../features/code-terminal/plugin.js";
import { createCodeToolsPlugin } from "../features/code-tools/plugin.js";
import { createCodeUiAgentEventsPlugin } from "../features/code-ui/agent-events-plugin.js";
import { createCodeUiPlugin } from "../features/code-ui/plugin.js";
import { createComputerUsePlugin } from "../features/computer-use/plugin.js";
import { createContextHistoryPlugin } from "../features/context-history/plugin.js";
import { designReviewPlugin } from "../features/design-review/plugin.js";
import { createDynamicUiPlugin } from "../features/dynamic-ui/plugin.js";
import { createExecutionScopesPlugin } from "../features/execution/plugin.js";
import { createFlowHostPlugin } from "../features/flow/plugin.js";
import { createGenerationTargetsPlugin } from "../features/generation/file-targets-plugin.js";
import { createGenerationPlugin } from "../features/generation/plugin.js";
import { createGoalsPlugin } from "../features/goals/plugin.js";
import { createJobLoopPlugin } from "../features/jobs/job-loop-plugin.js";
import type { JobService } from "../features/jobs/job-service.js";
import { createJobsPlugin } from "../features/jobs/plugin.js";
import {
  createLocalAccessPlugin,
  createLocalAccessRoutesPlugin,
} from "../features/local-access/plugin.js";
import { createInstanceRoutesPlugin } from "../features/local-instance/http-plugin.js";
import { createLocalInstancePlugin } from "../features/local-instance/plugin.js";
import { createMcpPlugin } from "../features/mcp/plugin.js";
import {
  createMediaDriverRoutesPlugin,
  createMediaDriversPlugin,
} from "../features/media-drivers/plugin.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import {
  createModelProviderRoutesPlugin,
  createModelProvidersPlugin,
} from "../features/model-providers/plugin.js";
import { createOpenDesignHostPlugin } from "../features/open-design/plugin.js";
import { createApprovalReviewPlugin } from "../features/permissions/approval-review-plugin.js";
import { createPermissionsPlugin } from "../features/permissions/plugin.js";
import { persistencePlugin } from "../features/persistence/plugin.js";
import {
  createPluginsPlugin,
  type PluginCatalogEntry,
} from "../features/plugins/plugin.js";
import { createProcessSandboxPlugin } from "../features/process-sandbox/plugin.js";
import { createProjectFilesPlugin } from "../features/project-files/plugin.js";
import { createProjectDirectoryRelinkPlugin } from "../features/projects/directory-relink-plugin.js";
import { createProjectsPlugin } from "../features/projects/plugin.js";
import { createQueuePlugin } from "../features/queue/plugin.js";
import { createSearchPlugin } from "../features/search/plugin.js";
import {
  createSettingsPlugin,
  createSettingsRoutesPlugin,
} from "../features/settings/plugin.js";
import { createSkillsPlugin } from "../features/skills/plugin.js";
import { createSystemPlugin } from "../features/system/plugin.js";
import { createTaskWorkPlugin } from "../features/task-work/plugin.js";
import { createToolCatalogPlugin } from "../features/tool-catalog/plugin.js";
import { createUploadsPlugin } from "../features/uploads/plugin.js";
import { createUsagePlugin } from "../features/usage/plugin.js";
import { createVoicePlugin } from "../features/voice/plugin.js";
import type { KernelEvents, PluginDefinition } from "../kernel/types.js";
import type { ConnectionManager } from "../ws/connection-manager.js";

/**
 * server profile（§4.9）：HTTP 进程的插件清单——唯一属主。
 * 新增 feature 插件只改这里一行（P8 起 app.ts 不再维护清单）。
 */

export interface ServerProfileDeps {
  connectionManager: ConnectionManager;
  events: KernelEvents;
  env: ServerEnv;
  agentFactory?: KenFutWorkAgentFactory;
  runtimeProvider?: AgentRuntimeProvider;
  agentModel?: BaseLanguageModel | string;
  mockEventDelayMs?: number;
  /** overrides 直填的条件装配插件需感知注入实例（enabled 判定，保持历史行为）。 */
  overrideJobs?: JobService;
  /** 测试替身：modelProviders 缝的注入实例（app.test/generate.test 用）。 */
  overrideModelProviders?: ModelProviderService;
  /** GitHub token（可选）：插件从仓库安装时提升匿名速率上限。 */
  githubToken?: string;
}

/** 插件市场目录：与清单同源维护（真实注册项的说明 + 能力声明，供导出用）。 */
export const PLUGIN_CATALOG: PluginCatalogEntry[] = [
  {
    name: "model-providers",
    title: "BYOK 供应商",
    category: "模型与供应商",
    description:
      "添加你自己的模型实例（OpenAI 兼容 / Anthropic / Gemini / 图像 / 视频协议），Key 在本地明文文件保存。",
    capabilities: ["llm"],
  },
  {
    name: "agent-runs",
    title: "Agent 运行时",
    category: "Agent 能力",
    description: "任务编排 · 流式输出 · 工具调用",
    capabilities: ["agents", "tools"],
  },
  {
    name: "checkpoints",
    title: "检查点",
    category: "Agent 能力",
    description: "每轮快照 · 查看改动 · 一键回滚",
    capabilities: [],
  },
  {
    name: "permissions",
    title: "权限策略",
    category: "Agent 能力",
    description: "危险工具四档审批",
    capabilities: ["tools"],
  },
  {
    name: "search",
    title: "联网搜索",
    category: "工具与集成",
    description: "web_search · 实时信息",
    capabilities: ["tools"],
  },
  {
    name: "mcp",
    title: "MCP 接入",
    category: "工具与集成",
    description: "连接 MCP server · 工具进注册表",
    capabilities: ["tools"],
  },
  {
    name: "usage",
    title: "用量统计",
    category: "数据与统计",
    description: "token 与成本计量",
    capabilities: [],
  },
  {
    name: "canvas",
    title: "画布（Design）",
    category: "创作与画布",
    description: "画布 · 品牌套件 · 图像/视频生成",
    capabilities: ["tools"],
  },
  {
    name: "skills",
    title: "技能",
    category: "创作与画布",
    description: "技能发现与市场",
    capabilities: ["tools"],
  },
  {
    name: "plugin-registry",
    title: "插件市场",
    category: "系统",
    description: "安装第三方插件 · 兼容性门禁 · 导入导出",
    capabilities: [],
  },
];

export function serverProfile(deps: ServerProfileDeps): PluginDefinition[] {
  return [
    persistencePlugin,
    createLocalInstancePlugin(),
    createLocalAccessPlugin(),
    createLocalAccessRoutesPlugin(),
    createInstanceRoutesPlugin(),
    createQueuePlugin(),
    createBlobPlugin(),
    brandKitPlugin,
    createCanvasPlugin(),
    createCanvasToolsPlugin(),
    createCanvasPublicationRelayPlugin(),
    designReviewPlugin,
    createCodeGitPlugin(),
    // 检查点（影子 git）在 agent-runs 之前装配：后者的轮次钩子经 tryGet 消费它
    createCheckpointsPlugin(),
    createGoalsPlugin(),
    createChatPlugin(),
    createSettingsPlugin(),
    createSettingsRoutesPlugin(),
    createMediaDriversPlugin(),
    createMediaDriverRoutesPlugin(),
    createExecutionScopesPlugin(),
    createProcessSandboxPlugin(),
    createCodeTerminalPlugin(),
    createTaskWorkPlugin(),
    createCodeSubagentsPlugin(),
    createToolCatalogPlugin(),
    createContextHistoryPlugin(),
    createUploadsPlugin(),
    createProjectsPlugin(),
    createProjectDirectoryRelinkPlugin(),
    createProjectFilesPlugin(),
    createCanvasAssetLocationsPlugin(),
    createGenerationTargetsPlugin(),
    createJobsPlugin({
      ...(deps.overrideJobs ? { injected: deps.overrideJobs } : {}),
    }),
    createJobLoopPlugin({ enabled: isDesktopRuntime, tag: "[desktop-worker]" }),
    createSkillsPlugin(),
    createUsagePlugin(),
    createPermissionsPlugin({ events: deps.events }),
    createApprovalReviewPlugin(),
    createCodeToolsPlugin(),
    createCodeUiAgentEventsPlugin(),
    // Computer Use（CU 插件重活层）：工具面按安装态门控，非 darwin 显式 unavailable
    createComputerUsePlugin(),
    createCadPlugin(),
    createMcpPlugin(),
    createSearchPlugin(),
    createSystemPlugin(),
    createModelProvidersPlugin({
      ...(deps.overrideModelProviders
        ? { injectedModelProviders: deps.overrideModelProviders }
        : {}),
    }),
    createModelProviderRoutesPlugin(),
    createGenerationPlugin({ env: deps.env }),
    // flow 宿主适配层：配了共享密钥才注册 /api/flow/host/*（见 features/flow/plugin.ts）
    createFlowHostPlugin({
      secret: deps.env.flowEmbedSecret,
      frontendUrl: deps.env.flowFrontendUrl,
      gatewayUrl: deps.env.flowGatewayUrl,
    }),
    // OpenDesign 宿主适配层：Code 模式右侧栏的能力探针 /api/open-design/host/status
    // （入口本身由 plugins/open-design 的安装态门控，见 features/open-design/plugin.ts）；
    // O3/OD-4：配了共享密钥，daemon 才能调 /credentials 把 BYOK 凭证下发给它的 agent CLI
    createOpenDesignHostPlugin({
      frontendUrl: deps.env.openDesignFrontendUrl,
      ...(deps.env.openDesignEmbedSecret
        ? { secret: deps.env.openDesignEmbedSecret }
        : {}),
    }),
    createBrowserPlugin(),
    // 语音助手（内建插件，默认开启）：听/说走内置 sherpa 或 BYOK 实例端点
    createVoicePlugin(),
    // 动态 UI（对话流可视化）：只贡献提示段（mermaid / viz 两种块；渲染在两端）
    createDynamicUiPlugin(),
    createPluginsPlugin({
      builtinCatalog: PLUGIN_CATALOG,
      ...(deps.githubToken ? { githubToken: deps.githubToken } : {}),
    }),
    createAgentRunsPlugin({
      connectionManager: deps.connectionManager,
      events: deps.events,
      // pre-step改写权交给指导事件监听器。
      emitPreStep: (payload) => deps.events.emitPreStep(payload),
      ...(deps.agentFactory ? { agentFactory: deps.agentFactory } : {}),
      ...(deps.runtimeProvider
        ? { runtimeProvider: deps.runtimeProvider }
        : {}),
      ...(deps.agentModel ? { agentModel: deps.agentModel } : {}),
      ...(deps.mockEventDelayMs === undefined
        ? {}
        : { mockEventDelayMs: deps.mockEventDelayMs }),
    }),
    createCodeUiPlugin(),
    createRealtimePlugin(),
  ];
}
