import {
  clampCodeUiReconnectDelayMs,
  clampExecuteTimeoutMs,
  clampLlmRequestMaxRetries,
  clampSubagentMaxConcurrency,
  clampSubagentMaxContinuations,
  clampSubagentMaxDepth,
  modelDefaultsSchema,
  RUNTIME_GOVERNANCE_KEYS,
  resolveGovernanceNumber,
} from "@kenfutwork/shared";
import { clampMaxRunRetries } from "../../agent/run-retry.js";
import type { SettingsOperations } from "./repository.js";
import type { InstanceSettingsPatch } from "./settings-service.js";

type PatchWrite = {
  writer: SettingsOperations;
  instanceId: string;
  patch: InstanceSettingsPatch;
};

function modelWrites({
  writer,
  instanceId,
  patch,
}: PatchWrite): Promise<void>[] {
  const writes: Promise<void>[] = [];
  if (patch.modelDefaults !== undefined)
    writes.push(
      writer.upsertModelDefaults(
        instanceId,
        modelDefaultsSchema.parse(patch.modelDefaults),
      ),
    );
  if (patch.codeUiReconnectDelayMs !== undefined)
    writes.push(
      writer.upsertCodeUiReconnectDelayMs(
        instanceId,
        clampCodeUiReconnectDelayMs(patch.codeUiReconnectDelayMs),
      ),
    );
  if (patch.defaultModel !== undefined) {
    writes.push(writer.upsertDefaultModel(instanceId, patch.defaultModel));
  }
  return writes;
}

function preferencesWrites({
  writer,
  instanceId,
  patch,
}: PatchWrite): Promise<void>[] {
  const writes: Promise<void>[] = [];
  if (patch.terminalShell !== undefined) {
    writes.push(writer.upsertTerminalShell(instanceId, patch.terminalShell));
  }
  if (patch.codeIndexEnabled !== undefined) {
    writes.push(
      writer.upsertCodeIndexEnabled(instanceId, patch.codeIndexEnabled),
    );
  }
  if (patch.codeIndexAutoNewFolder !== undefined) {
    writes.push(
      writer.upsertCodeIndexAutoNewFolder(
        instanceId,
        patch.codeIndexAutoNewFolder,
      ),
    );
  }
  if (patch.autoCompactEnabled !== undefined) {
    writes.push(
      writer.upsertAutoCompactEnabled(instanceId, patch.autoCompactEnabled),
    );
  }
  if (patch.hooks !== undefined) {
    writes.push(writer.upsertHooks(instanceId, patch.hooks));
  }
  if (patch.commands !== undefined) {
    writes.push(writer.upsertCommands(instanceId, patch.commands));
  }
  if (patch.userRules !== undefined) {
    writes.push(writer.upsertUserRules(instanceId, patch.userRules));
  }
  if (patch.ruleEntries !== undefined) {
    writes.push(writer.upsertRuleEntries(instanceId, patch.ruleEntries));
  }
  return writes;
}

function governanceWrites({
  writer,
  instanceId,
  patch,
}: PatchWrite): Promise<void>[] {
  const writes: Promise<void>[] = [];
  if (patch.agentMaxRetries !== undefined) {
    writes.push(
      writer.upsertAgentMaxRetries(
        instanceId,
        clampMaxRunRetries(patch.agentMaxRetries),
      ),
    );
  }
  if (patch.subagentMaxDepth !== undefined) {
    writes.push(
      writer.upsertSubagentMaxDepth(
        instanceId,
        clampSubagentMaxDepth(patch.subagentMaxDepth),
      ),
    );
  }
  if (patch.subagentMaxConcurrency !== undefined) {
    writes.push(
      writer.upsertSubagentMaxConcurrency(
        instanceId,
        clampSubagentMaxConcurrency(patch.subagentMaxConcurrency),
      ),
    );
  }
  if (patch.subagentMaxContinuations !== undefined) {
    writes.push(
      writer.upsertSubagentMaxContinuations(
        instanceId,
        clampSubagentMaxContinuations(patch.subagentMaxContinuations),
      ),
    );
  }
  if (patch.llmRequestMaxRetries !== undefined) {
    writes.push(
      writer.upsertLlmRequestMaxRetries(
        instanceId,
        clampLlmRequestMaxRetries(patch.llmRequestMaxRetries),
      ),
    );
  }
  if (patch.llmInfiniteRetry !== undefined) {
    writes.push(
      writer.upsertLlmInfiniteRetry(instanceId, patch.llmInfiniteRetry),
    );
  }
  if (patch.executeTimeoutMs !== undefined) {
    writes.push(
      writer.upsertExecuteTimeoutMs(
        instanceId,
        clampExecuteTimeoutMs(patch.executeTimeoutMs),
      ),
    );
  }
  const runtimePatch = Object.fromEntries(
    RUNTIME_GOVERNANCE_KEYS.flatMap((key) =>
      patch[key] === undefined
        ? []
        : [[key, resolveGovernanceNumber(key, patch[key])]],
    ),
  );
  if (Object.keys(runtimePatch).length > 0) {
    writes.push(writer.upsertRuntimeGovernance(instanceId, runtimePatch));
  }
  return writes;
}

export async function writeSettingsPatch(context: PatchWrite): Promise<void> {
  await Promise.all([
    ...modelWrites(context),
    ...preferencesWrites(context),
    ...governanceWrites(context),
  ]);
}
