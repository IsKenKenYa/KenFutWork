import type { TerminalShellId } from "@kenfutwork/shared";

import type { PersistenceService } from "../persistence/types.js";

/**
 * settings 聚合的数据访问（`workspace_settings`）。
 * 表以 `workspace_id` 为主键，故 upsert 天然是「一工作区一行」。
 */
export interface SettingsRepository {
  findRuntimeGovernance(workspaceId: string): Promise<unknown>;
  upsertRuntimeGovernance(
    workspaceId: string,
    patch: Record<string, number>,
  ): Promise<void>;
  findCodeUiReconnectDelayMs(workspaceId: string): Promise<number | null>;
  upsertCodeUiReconnectDelayMs(
    workspaceId: string,
    value: number,
  ): Promise<void>;
  /** 读默认模型；无行返回 null（由服务落回退默认值）。 */
  findDefaultModel(workspaceId: string): Promise<string | null>;
  /** 读 run 重试上限；无行返回 null（由服务落缺省 10）。 */
  findAgentMaxRetries(workspaceId: string): Promise<number | null>;
  /** 读终端默认 shell；无行返回 null（由服务落 `auto`）。 */
  findTerminalShell(workspaceId: string): Promise<TerminalShellId | null>;
  /** 读代码库索引开关；无行返回 null（由服务落 false）。 */
  findCodeIndexEnabled(workspaceId: string): Promise<boolean | null>;
  /** 读用户规则与规则条目；无行返回 null。 */
  findUserRules(
    workspaceId: string,
  ): Promise<{ userRules: string; ruleEntries: string[] } | null>;
  /** 一工作区一行，冲突即更新。 */
  upsertDefaultModel(workspaceId: string, defaultModel: string): Promise<void>;
  upsertAgentMaxRetries(
    workspaceId: string,
    agentMaxRetries: number,
  ): Promise<void>;
  upsertTerminalShell(
    workspaceId: string,
    terminalShell: TerminalShellId,
  ): Promise<void>;
  upsertCodeIndexEnabled(workspaceId: string, enabled: boolean): Promise<void>;
  findCodeIndexAutoNewFolder(workspaceId: string): Promise<boolean | null>;
  findAutoCompactEnabled(workspaceId: string): Promise<boolean | null>;
  findCommands(workspaceId: string): Promise<unknown>;
  upsertCommands(workspaceId: string, commands: unknown): Promise<void>;
  findHooks(workspaceId: string): Promise<unknown>;
  upsertHooks(workspaceId: string, hooks: unknown): Promise<void>;
  upsertAutoCompactEnabled(
    workspaceId: string,
    enabled: boolean,
  ): Promise<void>;
  upsertCodeIndexAutoNewFolder(
    workspaceId: string,
    enabled: boolean,
  ): Promise<void>;
  upsertUserRules(workspaceId: string, userRules: string): Promise<void>;
  upsertRuleEntries(workspaceId: string, entries: string[]): Promise<void>;
  /** agent 治理五项（DEC-17/DEC-18）：逐列读写，缺列返回 null 由服务落 DEFAULTS。 */
  findSubagentMaxDepth(workspaceId: string): Promise<number | null>;
  findSubagentMaxConcurrency(workspaceId: string): Promise<number | null>;
  findLlmRequestMaxRetries(workspaceId: string): Promise<number | null>;
  findLlmInfiniteRetry(workspaceId: string): Promise<boolean | null>;
  findExecuteTimeoutMs(workspaceId: string): Promise<number | null>;
  findSubagentMaxContinuations(workspaceId: string): Promise<number | null>;
  upsertSubagentMaxDepth(workspaceId: string, value: number): Promise<void>;
  upsertSubagentMaxContinuations(
    workspaceId: string,
    value: number,
  ): Promise<void>;
  upsertSubagentMaxConcurrency(
    workspaceId: string,
    value: number,
  ): Promise<void>;
  upsertLlmRequestMaxRetries(workspaceId: string, value: number): Promise<void>;
  upsertLlmInfiniteRetry(workspaceId: string, value: boolean): Promise<void>;
  upsertExecuteTimeoutMs(workspaceId: string, value: number): Promise<void>;
}

type DefaultModelRow = { default_model: string };
type AgentMaxRetriesRow = { agent_max_retries: number };
type TerminalShellRow = { terminal_shell: TerminalShellId };
type CodeIndexEnabledRow = { code_index_enabled: boolean };
type CodeIndexAutoNewFolderRow = { code_index_auto_new_folder: boolean };
type AutoCompactEnabledRow = { auto_compact_enabled: boolean };
type CommandsRow = { commands: unknown };
type HooksRow = { hooks: unknown };
type UserRulesRow = { user_rules: string; rule_entries: unknown };
type SubagentMaxDepthRow = { subagent_max_depth: number };
type SubagentMaxConcurrencyRow = { subagent_max_concurrency: number };
type LlmRequestMaxRetriesRow = { llm_request_max_retries: number };
type LlmInfiniteRetryRow = { llm_infinite_retry: boolean };
type ExecuteTimeoutMsRow = { execute_timeout_ms: number };
type SubagentMaxContinuationsRow = { subagent_max_continuations: number };

export function createSettingsRepository(
  persistence: PersistenceService,
): SettingsRepository {
  return {
    async findRuntimeGovernance(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<{ runtime_governance: unknown }>(
          "select runtime_governance from public.workspace_settings where workspace_id = :workspace",
        );
      return row?.runtime_governance ?? {};
    },
    async upsertRuntimeGovernance(workspaceId, patch) {
      await persistence.forWorkspace(workspaceId).execute(
        `insert into public.workspace_settings (workspace_id, runtime_governance)
         values (:workspace, $1::jsonb)
         on conflict (workspace_id) do update
         set runtime_governance = public.workspace_settings.runtime_governance || excluded.runtime_governance`,
        [JSON.stringify(patch)],
      );
    },
    async findCodeUiReconnectDelayMs(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<{ code_ui_reconnect_delay_ms: number | null }>(
          `select code_ui_reconnect_delay_ms from public.workspace_settings where workspace_id = :workspace`,
        );
      return row?.code_ui_reconnect_delay_ms ?? null;
    },
    async upsertCodeUiReconnectDelayMs(workspaceId, value) {
      await persistence
        .forWorkspace(workspaceId)
        .execute(
          `insert into public.workspace_settings (workspace_id, code_ui_reconnect_delay_ms) values (:workspace, $1) on conflict (workspace_id) do update set code_ui_reconnect_delay_ms = excluded.code_ui_reconnect_delay_ms`,
          [value],
        );
    },
    async findDefaultModel(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<DefaultModelRow>(
          `select default_model
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.default_model ?? null;
    },

    async findAgentMaxRetries(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<AgentMaxRetriesRow>(
          `select agent_max_retries
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.agent_max_retries ?? null;
    },

    async findTerminalShell(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<TerminalShellRow>(
          `select terminal_shell
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.terminal_shell ?? null;
    },

    async findCodeIndexEnabled(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<CodeIndexEnabledRow>(
          `select code_index_enabled
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.code_index_enabled ?? null;
    },

    async findCodeIndexAutoNewFolder(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<CodeIndexAutoNewFolderRow>(
          `select code_index_auto_new_folder
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.code_index_auto_new_folder ?? null;
    },

    async findAutoCompactEnabled(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<AutoCompactEnabledRow>(
          `select auto_compact_enabled
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.auto_compact_enabled ?? null;
    },

    async findCommands(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<CommandsRow>(
          `select commands
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.commands ?? null;
    },

    async upsertCommands(workspaceId, commands) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, commands)
         values (:workspace, $1::jsonb)
         on conflict (workspace_id)
         do update set commands = excluded.commands`,
        [JSON.stringify(commands)],
      );
    },

    async findHooks(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<HooksRow>(
          `select hooks
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.hooks ?? null;
    },

    async upsertHooks(workspaceId, hooks) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, hooks)
         values (:workspace, $1::jsonb)
         on conflict (workspace_id)
         do update set hooks = excluded.hooks`,
        [JSON.stringify(hooks)],
      );
    },

    async upsertDefaultModel(workspaceId, defaultModel) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, default_model)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set default_model = excluded.default_model`,
        [defaultModel],
      );
    },

    /** 终端默认 shell：同样逐列 upsert（三个设置各写各的列）。 */
    async upsertTerminalShell(workspaceId, terminalShell) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, terminal_shell)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set terminal_shell = excluded.terminal_shell`,
        [terminalShell],
      );
    },

    async findUserRules(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<UserRulesRow>(
          `select user_rules, rule_entries
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      if (!row) return null;
      const entries = Array.isArray(row.rule_entries)
        ? row.rule_entries.filter(
            (item): item is string =>
              typeof item === "string" && item.length > 0,
          )
        : [];
      return { userRules: row.user_rules ?? "", ruleEntries: entries };
    },

    async upsertUserRules(workspaceId, userRules) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, user_rules)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set user_rules = excluded.user_rules`,
        [userRules],
      );
    },

    async upsertRuleEntries(workspaceId, entries) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, rule_entries)
         values (:workspace, $1::jsonb)
         on conflict (workspace_id)
         do update set rule_entries = excluded.rule_entries`,
        [JSON.stringify(entries)],
      );
    },

    /** 代码库索引开关（R4-3）：同样逐列 upsert。 */
    async upsertCodeIndexEnabled(workspaceId, enabled) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, code_index_enabled)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set code_index_enabled = excluded.code_index_enabled`,
        [enabled],
      );
    },

    /** 自定义命令（整列覆盖：命令表是「一次编辑、整体保存」的形态）。 */
    async upsertAutoCompactEnabled(workspaceId, enabled) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, auto_compact_enabled)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set auto_compact_enabled = excluded.auto_compact_enabled`,
        [enabled],
      );
    },

    /** 「索引新文件夹」开关（R4-3 第二行）：同样逐列 upsert。 */
    async upsertCodeIndexAutoNewFolder(workspaceId, enabled) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, code_index_auto_new_folder)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set code_index_auto_new_folder = excluded.code_index_auto_new_folder`,
        [enabled],
      );
    },

    /**
     * 逐列 upsert：只写重试上限，不动默认模型。同一行上「每设置一条语句」比「整行覆盖」
     * 更抗并发——两个设置各自保存时不会把对方的改动盖掉。
     */
    async upsertAgentMaxRetries(workspaceId, agentMaxRetries) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, agent_max_retries)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set agent_max_retries = excluded.agent_max_retries`,
        [agentMaxRetries],
      );
    },

    async findSubagentMaxDepth(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<SubagentMaxDepthRow>(
          `select subagent_max_depth
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.subagent_max_depth ?? null;
    },

    async upsertSubagentMaxDepth(workspaceId, value) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, subagent_max_depth)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set subagent_max_depth = excluded.subagent_max_depth`,
        [value],
      );
    },

    async findSubagentMaxConcurrency(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<SubagentMaxConcurrencyRow>(
          `select subagent_max_concurrency
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.subagent_max_concurrency ?? null;
    },

    async upsertSubagentMaxConcurrency(workspaceId, value) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, subagent_max_concurrency)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set subagent_max_concurrency = excluded.subagent_max_concurrency`,
        [value],
      );
    },

    async findLlmRequestMaxRetries(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<LlmRequestMaxRetriesRow>(
          `select llm_request_max_retries
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.llm_request_max_retries ?? null;
    },

    async upsertLlmRequestMaxRetries(workspaceId, value) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, llm_request_max_retries)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set llm_request_max_retries = excluded.llm_request_max_retries`,
        [value],
      );
    },

    async findLlmInfiniteRetry(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<LlmInfiniteRetryRow>(
          `select llm_infinite_retry
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.llm_infinite_retry ?? null;
    },

    async upsertLlmInfiniteRetry(workspaceId, value) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, llm_infinite_retry)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set llm_infinite_retry = excluded.llm_infinite_retry`,
        [value],
      );
    },

    async findExecuteTimeoutMs(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<ExecuteTimeoutMsRow>(
          `select execute_timeout_ms
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.execute_timeout_ms ?? null;
    },

    async upsertExecuteTimeoutMs(workspaceId, value) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, execute_timeout_ms)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set execute_timeout_ms = excluded.execute_timeout_ms`,
        [value],
      );
    },

    async findSubagentMaxContinuations(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<SubagentMaxContinuationsRow>(
          `select subagent_max_continuations
             from public.workspace_settings
            where workspace_id = :workspace`,
        );
      return row?.subagent_max_continuations ?? null;
    },

    async upsertSubagentMaxContinuations(workspaceId, value) {
      await persistence.forWorkspace(workspaceId).query(
        `insert into public.workspace_settings (workspace_id, subagent_max_continuations)
         values (:workspace, $1)
         on conflict (workspace_id)
         do update set subagent_max_continuations = excluded.subagent_max_continuations`,
        [value],
      );
    },
  };
}
