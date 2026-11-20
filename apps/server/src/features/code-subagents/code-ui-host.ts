import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  codeUiSubagentsListQuerySchema,
} from "@kenfutwork/shared";
import {
  type AgentColor,
  type AgentPermissionMode,
  type AgentSummary,
  type AgentsListResult,
  modelSelectionSchema,
} from "@zcode/shared";
import { z } from "zod";
import type { SubagentDefinition } from "../../agent/subagent-definitions.js";
import {
  CodeUiHostRpcError,
  type CodeUiHostRpcHandler,
} from "../code-ui/host-rpc-handler.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import {
  ensureDefaultInstructionsFile,
  readDefaultInstructionsContent,
  writeDefaultInstructionsContent,
} from "./instance-instructions.js";
import {
  createUserAgent,
  defaultAgentsInstructionPath,
  deleteUserAgent,
  listUserAgents,
  setBuiltInModelOverride,
  setUserAgentEnabled,
  type UserAgentRecord,
  type UserAgentScope,
  updateUserAgent,
  userAgentsDirectory,
  workspaceAgentsDirectory,
} from "./user-agent-store.js";

/**
 * 设置页「智能体」的宿主读写面。
 *
 * 内置清单与派发同源（`SUBAGENT_DEFINITIONS`）；用户/工作区智能体按 ZCode 的
 * Markdown profile 存放，清单、启停与派发消费同一份文件。`capability` 如实上报
 * 本机实例支持用户作用域，界面因此开放新建/编辑/删除，而不是桌面端专属。
 */

const agentConfigSchema = z.object({
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  color: z
    .enum([
      "red",
      "blue",
      "green",
      "yellow",
      "purple",
      "orange",
      "pink",
      "cyan",
    ])
    .optional(),
  modelSelection: modelSelectionSchema.optional(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  injectAgentsMd: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
  permissionMode: z.enum(["auto", "plan"]).optional(),
  maxTurns: z.number().int().positive().optional(),
  background: z.boolean().optional(),
  mcpServers: z.array(z.unknown()).optional(),
});

const agentScopeSchema = z.enum(["user", "workspace"]);

const createAgentParamsSchema = z.object({
  config: agentConfigSchema,
  provider: z.string().optional(),
  scope: agentScopeSchema.optional(),
  workspacePath: z.string().optional(),
  workspaceIdentity: z.string().optional(),
});

const updateAgentParamsSchema = createAgentParamsSchema.extend({
  agentId: z.string().min(1),
  oldFilePath: z.string().optional(),
});

const deleteAgentParamsSchema = z.object({
  agentId: z.string().min(1),
  filePath: z.string().optional(),
});

const setEnabledParamsSchema = z.object({
  agentId: z.string().min(1),
  enabled: z.boolean(),
});

const builtInOverrideParamsSchema = z.object({
  agentName: z.string().min(1),
  modelSelection: modelSelectionSchema.optional(),
});

const pluginOverrideParamsSchema = z.object({
  agentId: z.string().min(1),
  modelSelection: modelSelectionSchema.optional(),
});

const instructionsContentSchema = z.object({ content: z.string() });

type AgentConfigInput = z.infer<typeof agentConfigSchema>;

function toSubAgentConfig(input: AgentConfigInput) {
  return {
    name: input.name,
    description: input.description,
    systemPrompt: input.systemPrompt,
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.modelSelection !== undefined
      ? { modelSelection: input.modelSelection }
      : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.disallowedTools !== undefined
      ? { disallowedTools: input.disallowedTools }
      : {}),
    ...(input.injectAgentsMd !== undefined
      ? { injectAgentsMd: input.injectAgentsMd }
      : {}),
    ...(input.skills !== undefined ? { skills: input.skills } : {}),
    ...(input.permissionMode !== undefined
      ? { permissionMode: input.permissionMode }
      : {}),
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    ...(input.background !== undefined ? { background: input.background } : {}),
    ...(input.mcpServers !== undefined ? { mcpServers: input.mcpServers } : {}),
  };
}

interface AgentTarget {
  dataDir: string;
  scope: UserAgentScope;
  directory: string;
}

export function createCodeUiSubagentsHost(deps: {
  localInstance: LocalInstanceService;
  definitions: () => readonly SubagentDefinition[];
}): Record<string, CodeUiHostRpcHandler> {
  const target = async (
    actor: Parameters<CodeUiHostRpcHandler["call"]>[0],
    scope: UserAgentScope,
    workspacePath: string | undefined,
  ): Promise<AgentTarget> => {
    const owner = await deps.localInstance.resolve(actor);
    if (scope === "user")
      return {
        dataDir: owner.dataDir,
        scope,
        directory: userAgentsDirectory(owner.dataDir),
      };
    const path = workspacePath?.trim();
    if (!path)
      throw new CodeUiHostRpcError(
        "workspace_agent_requires_workspace",
        "项目级智能体需要先打开项目。",
        400,
      );
    return {
      dataDir: owner.dataDir,
      scope,
      directory: workspaceAgentsDirectory(resolve(path)),
    };
  };

  return {
    "subagents.list": {
      async call(actor, args): Promise<AgentsListResult> {
        const owner = await deps.localInstance.resolve(actor);
        const query = codeUiSubagentsListQuerySchema.parse(args[0] ?? {});
        await ensureDefaultInstructionsFile(owner.dataDir);
        const user = await listUserAgents(
          owner.dataDir,
          "user",
          userAgentsDirectory(owner.dataDir),
        );
        const workspace =
          query.mode === "settingsUserOnly" || !query.workspacePath
            ? null
            : await listUserAgents(
                owner.dataDir,
                "workspace",
                workspaceAgentsDirectory(resolve(query.workspacePath)),
              );
        const disabled = new Set([
          ...user.state.disabledAgentIds,
          ...(workspace?.state.disabledAgentIds ?? []),
        ]);
        const userAgents = user.agents.map((agent) =>
          toAgentSummary(agent, disabled),
        );
        const workspaceAgents = (workspace?.agents ?? []).map((agent) =>
          toAgentSummary(agent, disabled),
        );
        const builtIns = deps
          .definitions()
          .map((definition) => toBuiltInSummary(definition));
        return {
          agents:
            query.mode === "settingsUserOnly"
              ? [...builtIns, ...userAgents]
              : [...builtIns, ...userAgents, ...workspaceAgents],
          userAgents,
          pluginAgents: [],
          capability: { userScopeAvailable: true },
          defaultInstructionsPath: defaultAgentsInstructionPath(owner.dataDir),
          diagnostics: [...user.diagnostics, ...(workspace?.diagnostics ?? [])],
        };
      },
    },
    "subagents.readDefaultInstructions": {
      async call(actor) {
        const owner = await deps.localInstance.resolve(actor);
        await ensureDefaultInstructionsFile(owner.dataDir);
        return {
          content: await readDefaultInstructionsContent(owner.dataDir),
        };
      },
    },
    "subagents.writeDefaultInstructions": {
      async call(actor, args) {
        const input = instructionsContentSchema.parse(args[0]);
        const bytes = Buffer.byteLength(input.content, "utf8");
        if (bytes > AGENT_GOVERNANCE_DEFAULTS.codeReadMaxBytes)
          throw new CodeUiHostRpcError(
            "instructions_too_large",
            "默认指令文件过大，请精简后再保存。",
            413,
          );
        const owner = await deps.localInstance.resolve(actor);
        await writeDefaultInstructionsContent(owner.dataDir, input.content);
        return null;
      },
    },
    "subagents.createAgent": {
      async call(actor, args) {
        const input = createAgentParamsSchema.parse(args[0]);
        const scope = input.scope ?? "user";
        const destination = await target(actor, scope, input.workspacePath);
        const agent = await createUserAgent({
          ...destination,
          config: toSubAgentConfig(input.config),
        });
        return { agent: toAgentSummary(agent, new Set()) };
      },
    },
    "subagents.updateAgent": {
      async call(actor, args) {
        const input = updateAgentParamsSchema.parse(args[0]);
        const scope = input.scope ?? "user";
        const destination = await target(actor, scope, input.workspacePath);
        const agent = await updateUserAgent({
          ...destination,
          agentId: input.agentId,
          config: toSubAgentConfig(input.config),
        });
        return { agent: toAgentSummary(agent, new Set()) };
      },
    },
    "subagents.deleteAgent": {
      async call(actor, args) {
        const input = deleteAgentParamsSchema.parse(args[0]);
        const scope = scopeFromAgentId(input.agentId);
        if (scope === "workspace") {
          // 删除只认 id 与「.zcode/agents」目录形状；真正删除的是该目录里
          // 同 id 记录的自身 path，客户端传来的 filePath 不直接参与 rm。
          const filePath = input.filePath?.trim();
          if (
            !filePath ||
            basename(dirname(filePath)) !== "agents" ||
            basename(dirname(dirname(filePath))) !== ".zcode"
          )
            throw new CodeUiHostRpcError(
              "workspace_agent_delete_requires_workspace",
              "项目级智能体缺少所属项目路径。",
              400,
            );
          const owner = await deps.localInstance.resolve(actor);
          await deleteUserAgent({
            dataDir: owner.dataDir,
            scope,
            directory: dirname(filePath),
            agentId: input.agentId,
          });
          return null;
        }
        const destination = await target(actor, scope, undefined);
        await deleteUserAgent({
          ...destination,
          agentId: input.agentId,
        });
        return null;
      },
    },
    "subagents.setEnabled": {
      async call(actor, args) {
        const input = setEnabledParamsSchema.parse(args[0]);
        const owner = await deps.localInstance.resolve(actor);
        await setUserAgentEnabled(owner.dataDir, input.agentId, input.enabled);
        return null;
      },
    },
    "subagents.setBuiltInModelOverride": {
      async call(actor, args) {
        const input = builtInOverrideParamsSchema.parse(args[0]);
        const owner = await deps.localInstance.resolve(actor);
        await setBuiltInModelOverride(
          owner.dataDir,
          input.agentName,
          input.modelSelection,
        );
        return null;
      },
    },
    "subagents.setPluginAgentModelOverride": {
      async call(_actor, args) {
        // 本机实例不把插件智能体投影成可写资源；保留方法是让界面不因未接通而报错。
        pluginOverrideParamsSchema.parse(args[0]);
        return null;
      },
    },
    "subagents.getPrimaryUserAgentsDirectory": {
      async call(actor) {
        const owner = await deps.localInstance.resolve(actor);
        const path = userAgentsDirectory(owner.dataDir);
        await mkdir(path, { recursive: true });
        return { path };
      },
    },
  };
}

function scopeFromAgentId(agentId: string): UserAgentScope {
  return agentId.startsWith("user:workspace:") ? "workspace" : "user";
}

function toBuiltInSummary(definition: SubagentDefinition): AgentSummary {
  return {
    id: `built-in:${definition.name}`,
    name: definition.label,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    tools: [...definition.tools, ...(definition.filesystemTools ?? [])],
    path: "",
    scope: "built-in",
    source: "built-in",
    enabled: true,
    readOnly: definition.readOnly,
    injectAgentsMd: true,
  };
}

function toAgentSummary(
  record: UserAgentRecord,
  disabled: ReadonlySet<string>,
): AgentSummary {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    systemPrompt: record.systemPrompt,
    ...(record.color ? { color: record.color as AgentColor } : {}),
    ...(record.modelSelection ? { modelSelection: record.modelSelection } : {}),
    ...(record.tools ? { tools: record.tools } : {}),
    ...(record.disallowedTools
      ? { disallowedTools: record.disallowedTools }
      : {}),
    ...(record.injectAgentsMd !== undefined
      ? { injectAgentsMd: record.injectAgentsMd }
      : {}),
    ...(record.skills ? { skills: record.skills } : {}),
    ...(record.permissionMode
      ? { permissionMode: record.permissionMode as AgentPermissionMode }
      : {}),
    ...(record.maxTurns ? { maxTurns: record.maxTurns } : {}),
    ...(record.background !== undefined
      ? { background: record.background }
      : {}),
    ...(record.mcpServers ? { mcpServers: record.mcpServers } : {}),
    path: record.path,
    scope: record.scope,
    source: "user",
    enabled: !disabled.has(record.id),
    readOnly: false,
  };
}
