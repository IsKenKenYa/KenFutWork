import type { ModelDefaults, TerminalShellId } from "@kenfutwork/shared";

import type { PersistenceService } from "../persistence/types.js";

/**
 * settings 聚合的数据访问（`instance_settings`）。
 * 表以 `instance_id` 为主键，故 upsert 天然是「一实例一行」。
 */
export interface SettingsOperations {
  findModelDefaults(instanceId: string): Promise<unknown>;
  upsertModelDefaults(instanceId: string, value: ModelDefaults): Promise<void>;
  findRuntimeGovernance(instanceId: string): Promise<unknown>;
  upsertRuntimeGovernance(
    instanceId: string,
    patch: Record<string, number>,
  ): Promise<void>;
  findCodeUiReconnectDelayMs(instanceId: string): Promise<number | null>;
  upsertCodeUiReconnectDelayMs(
    instanceId: string,
    value: number,
  ): Promise<void>;
  /** 读默认模型；无行返回 null（由服务落回退默认值）。 */
  findDefaultModel(instanceId: string): Promise<string | null>;
  /** 读 run 重试上限；无行返回 null（由服务落缺省 10）。 */
  findAgentMaxRetries(instanceId: string): Promise<number | null>;
  /** 读终端默认 shell；无行返回 null（由服务落 `auto`）。 */
  findTerminalShell(instanceId: string): Promise<TerminalShellId | null>;
  /** 读代码库索引开关；无行返回 null（由服务落 false）。 */
  findCodeIndexEnabled(instanceId: string): Promise<boolean | null>;
  /** 读用户规则与规则条目；无行返回 null。 */
  findUserRules(
    instanceId: string,
  ): Promise<{ userRules: string; ruleEntries: string[] } | null>;
  /** 一实例一行，冲突即更新。 */
  upsertDefaultModel(instanceId: string, defaultModel: string): Promise<void>;
  upsertAgentMaxRetries(
    instanceId: string,
    agentMaxRetries: number,
  ): Promise<void>;
  upsertTerminalShell(
    instanceId: string,
    terminalShell: TerminalShellId,
  ): Promise<void>;
  upsertCodeIndexEnabled(instanceId: string, enabled: boolean): Promise<void>;
  findCodeIndexAutoNewFolder(instanceId: string): Promise<boolean | null>;
  findAutoCompactEnabled(instanceId: string): Promise<boolean | null>;
  findCommands(instanceId: string): Promise<unknown>;
  upsertCommands(instanceId: string, commands: unknown): Promise<void>;
  findHooks(instanceId: string): Promise<unknown>;
  upsertHooks(instanceId: string, hooks: unknown): Promise<void>;
  upsertAutoCompactEnabled(instanceId: string, enabled: boolean): Promise<void>;
  upsertCodeIndexAutoNewFolder(
    instanceId: string,
    enabled: boolean,
  ): Promise<void>;
  upsertUserRules(instanceId: string, userRules: string): Promise<void>;
  upsertRuleEntries(instanceId: string, entries: string[]): Promise<void>;
  /** agent 治理五项（DEC-17/DEC-18）：逐列读写，缺列返回 null 由服务落 DEFAULTS。 */
  findSubagentMaxDepth(instanceId: string): Promise<number | null>;
  findSubagentMaxConcurrency(instanceId: string): Promise<number | null>;
  findLlmRequestMaxRetries(instanceId: string): Promise<number | null>;
  findLlmInfiniteRetry(instanceId: string): Promise<boolean | null>;
  findExecuteTimeoutMs(instanceId: string): Promise<number | null>;
  findSubagentMaxContinuations(instanceId: string): Promise<number | null>;
  upsertSubagentMaxDepth(instanceId: string, value: number): Promise<void>;
  upsertSubagentMaxContinuations(
    instanceId: string,
    value: number,
  ): Promise<void>;
  upsertSubagentMaxConcurrency(
    instanceId: string,
    value: number,
  ): Promise<void>;
  upsertLlmRequestMaxRetries(instanceId: string, value: number): Promise<void>;
  upsertLlmInfiniteRetry(instanceId: string, value: boolean): Promise<void>;
  upsertExecuteTimeoutMs(instanceId: string, value: number): Promise<void>;
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

export interface SettingsRepository extends SettingsOperations {
  atomicUpdate(
    operation: (repository: SettingsOperations) => Promise<void>,
  ): Promise<void>;
}

export function createSettingsRepository(
  persistence: PersistenceService,
): SettingsRepository {
  return {
    ...createSettingsOperations(persistence),
    atomicUpdate: (operation) =>
      persistence.transaction((tx) => operation(createSettingsOperations(tx))),
  };
}

function createSettingsOperations(
  persistence: Pick<PersistenceService, "forInstance">,
): SettingsOperations {
  return {
    async findModelDefaults(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<{ model_defaults: unknown }>(
          "select model_defaults from public.instance_settings where instance_id = :instance",
        );
      return row?.model_defaults ?? null;
    },
    async upsertModelDefaults(instanceId, value) {
      await persistence.forInstance(instanceId).execute(
        `insert into public.instance_settings (instance_id, model_defaults)
         values (:instance, $1::jsonb)
         on conflict (instance_id) do update set model_defaults = excluded.model_defaults`,
        [JSON.stringify(value)],
      );
    },
    async findRuntimeGovernance(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<{ runtime_governance: unknown }>(
          "select runtime_governance from public.instance_settings where instance_id = :instance",
        );
      return row?.runtime_governance ?? {};
    },
    async upsertRuntimeGovernance(instanceId, patch) {
      await persistence.forInstance(instanceId).execute(
        `insert into public.instance_settings (instance_id, runtime_governance)
         values (:instance, $1::jsonb)
         on conflict (instance_id) do update
         set runtime_governance = public.instance_settings.runtime_governance || excluded.runtime_governance`,
        [JSON.stringify(patch)],
      );
    },
    async findCodeUiReconnectDelayMs(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<{ code_ui_reconnect_delay_ms: number | null }>(
          `select code_ui_reconnect_delay_ms from public.instance_settings where instance_id = :instance`,
        );
      return row?.code_ui_reconnect_delay_ms ?? null;
    },
    async upsertCodeUiReconnectDelayMs(instanceId, value) {
      await persistence
        .forInstance(instanceId)
        .execute(
          `insert into public.instance_settings (instance_id, code_ui_reconnect_delay_ms) values (:instance, $1) on conflict (instance_id) do update set code_ui_reconnect_delay_ms = excluded.code_ui_reconnect_delay_ms`,
          [value],
        );
    },
    async findDefaultModel(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<DefaultModelRow>(
          `select default_model
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.default_model ?? null;
    },

    async findAgentMaxRetries(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<AgentMaxRetriesRow>(
          `select agent_max_retries
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.agent_max_retries ?? null;
    },

    async findTerminalShell(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<TerminalShellRow>(
          `select terminal_shell
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.terminal_shell ?? null;
    },

    async findCodeIndexEnabled(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<CodeIndexEnabledRow>(
          `select code_index_enabled
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.code_index_enabled ?? null;
    },

    async findCodeIndexAutoNewFolder(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<CodeIndexAutoNewFolderRow>(
          `select code_index_auto_new_folder
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.code_index_auto_new_folder ?? null;
    },

    async findAutoCompactEnabled(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<AutoCompactEnabledRow>(
          `select auto_compact_enabled
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.auto_compact_enabled ?? null;
    },

    async findCommands(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<CommandsRow>(
          `select commands
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.commands ?? null;
    },

    async upsertCommands(instanceId, commands) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, commands)
         values (:instance, $1::jsonb)
         on conflict (instance_id)
         do update set commands = excluded.commands`,
        [JSON.stringify(commands)],
      );
    },

    async findHooks(instanceId) {
      const row = await persistence.forInstance(instanceId).queryOne<HooksRow>(
        `select hooks
             from public.instance_settings
            where instance_id = :instance`,
      );
      return row?.hooks ?? null;
    },

    async upsertHooks(instanceId, hooks) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, hooks)
         values (:instance, $1::jsonb)
         on conflict (instance_id)
         do update set hooks = excluded.hooks`,
        [JSON.stringify(hooks)],
      );
    },

    async upsertDefaultModel(instanceId, defaultModel) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, default_model)
         values (:instance, $1)
         on conflict (instance_id)
         do update set default_model = excluded.default_model`,
        [defaultModel],
      );
    },

    /** 终端默认 shell：同样逐列 upsert（三个设置各写各的列）。 */
    async upsertTerminalShell(instanceId, terminalShell) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, terminal_shell)
         values (:instance, $1)
         on conflict (instance_id)
         do update set terminal_shell = excluded.terminal_shell`,
        [terminalShell],
      );
    },

    async findUserRules(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<UserRulesRow>(
          `select user_rules, rule_entries
             from public.instance_settings
            where instance_id = :instance`,
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

    async upsertUserRules(instanceId, userRules) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, user_rules)
         values (:instance, $1)
         on conflict (instance_id)
         do update set user_rules = excluded.user_rules`,
        [userRules],
      );
    },

    async upsertRuleEntries(instanceId, entries) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, rule_entries)
         values (:instance, $1::jsonb)
         on conflict (instance_id)
         do update set rule_entries = excluded.rule_entries`,
        [JSON.stringify(entries)],
      );
    },

    /** 代码库索引开关（R4-3）：同样逐列 upsert。 */
    async upsertCodeIndexEnabled(instanceId, enabled) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, code_index_enabled)
         values (:instance, $1)
         on conflict (instance_id)
         do update set code_index_enabled = excluded.code_index_enabled`,
        [enabled],
      );
    },

    /** 自定义命令（整列覆盖：命令表是「一次编辑、整体保存」的形态）。 */
    async upsertAutoCompactEnabled(instanceId, enabled) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, auto_compact_enabled)
         values (:instance, $1)
         on conflict (instance_id)
         do update set auto_compact_enabled = excluded.auto_compact_enabled`,
        [enabled],
      );
    },

    /** 「索引新文件夹」开关（R4-3 第二行）：同样逐列 upsert。 */
    async upsertCodeIndexAutoNewFolder(instanceId, enabled) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, code_index_auto_new_folder)
         values (:instance, $1)
         on conflict (instance_id)
         do update set code_index_auto_new_folder = excluded.code_index_auto_new_folder`,
        [enabled],
      );
    },

    /**
     * 逐列 upsert：只写重试上限，不动默认模型。同一行上「每设置一条语句」比「整行覆盖」
     * 更抗并发——两个设置各自保存时不会把对方的改动盖掉。
     */
    async upsertAgentMaxRetries(instanceId, agentMaxRetries) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, agent_max_retries)
         values (:instance, $1)
         on conflict (instance_id)
         do update set agent_max_retries = excluded.agent_max_retries`,
        [agentMaxRetries],
      );
    },

    async findSubagentMaxDepth(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<SubagentMaxDepthRow>(
          `select subagent_max_depth
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.subagent_max_depth ?? null;
    },

    async upsertSubagentMaxDepth(instanceId, value) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, subagent_max_depth)
         values (:instance, $1)
         on conflict (instance_id)
         do update set subagent_max_depth = excluded.subagent_max_depth`,
        [value],
      );
    },

    async findSubagentMaxConcurrency(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<SubagentMaxConcurrencyRow>(
          `select subagent_max_concurrency
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.subagent_max_concurrency ?? null;
    },

    async upsertSubagentMaxConcurrency(instanceId, value) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, subagent_max_concurrency)
         values (:instance, $1)
         on conflict (instance_id)
         do update set subagent_max_concurrency = excluded.subagent_max_concurrency`,
        [value],
      );
    },

    async findLlmRequestMaxRetries(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<LlmRequestMaxRetriesRow>(
          `select llm_request_max_retries
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.llm_request_max_retries ?? null;
    },

    async upsertLlmRequestMaxRetries(instanceId, value) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, llm_request_max_retries)
         values (:instance, $1)
         on conflict (instance_id)
         do update set llm_request_max_retries = excluded.llm_request_max_retries`,
        [value],
      );
    },

    async findLlmInfiniteRetry(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<LlmInfiniteRetryRow>(
          `select llm_infinite_retry
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.llm_infinite_retry ?? null;
    },

    async upsertLlmInfiniteRetry(instanceId, value) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, llm_infinite_retry)
         values (:instance, $1)
         on conflict (instance_id)
         do update set llm_infinite_retry = excluded.llm_infinite_retry`,
        [value],
      );
    },

    async findExecuteTimeoutMs(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<ExecuteTimeoutMsRow>(
          `select execute_timeout_ms
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.execute_timeout_ms ?? null;
    },

    async upsertExecuteTimeoutMs(instanceId, value) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, execute_timeout_ms)
         values (:instance, $1)
         on conflict (instance_id)
         do update set execute_timeout_ms = excluded.execute_timeout_ms`,
        [value],
      );
    },

    async findSubagentMaxContinuations(instanceId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<SubagentMaxContinuationsRow>(
          `select subagent_max_continuations
             from public.instance_settings
            where instance_id = :instance`,
        );
      return row?.subagent_max_continuations ?? null;
    },

    async upsertSubagentMaxContinuations(instanceId, value) {
      await persistence.forInstance(instanceId).query(
        `insert into public.instance_settings (instance_id, subagent_max_continuations)
         values (:instance, $1)
         on conflict (instance_id)
         do update set subagent_max_continuations = excluded.subagent_max_continuations`,
        [value],
      );
    },
  };
}
