/**
 * SAG2 知识库的治理数值读取（DEC-18）：库值 ?? env ?? DEFAULTS。
 *
 * 数值与护栏的唯一属主是 `packages/shared/src/governance.ts`；这里只做
 * 「按实例读 `instance_settings.runtime_governance` → 钳回」的读侧编排。
 * 读库失败不阻断对话：告警后落 env/默认值（preflight 失败不阻断，KB-4）。
 */

import {
  type AgentGovernanceOverrides,
  resolveGovernanceBool,
  resolveGovernanceNumber,
} from "@kenfutwork/shared";
import type { PersistenceService } from "../persistence/types.js";
import { createSettingsRepository } from "../settings/repository.js";

/** 运行时消费的设置快照（字段名去前缀，属 knowledge 域内部）。 */
export interface KnowledgeRuntimeSettings {
  autoInject: boolean;
  localMatch: boolean;
  maxResults: number;
  minHits: number;
  searchTimeoutMs: number;
  maxConcurrentSearches: number;
  evidenceMaxChars: number;
  cacheTtlMs: number;
  readMaxBytes: number;
  /** 目录/状态命令预算（service 冷启动）：路由与面板心跳消费，不进面板设置项。 */
  listTimeoutMs: number;
  listRetries: number;
}

export type KnowledgeSettingsReader = (
  instanceId?: string | undefined,
) => Promise<KnowledgeRuntimeSettings>;

export function createKnowledgeSettingsReader(deps: {
  /** 最小装配 / worker 无持久化时只用 env + 默认值。 */
  persistence?: PersistenceService | undefined;
  env?: AgentGovernanceOverrides | undefined;
}): KnowledgeSettingsReader {
  const repository = deps.persistence
    ? createSettingsRepository(deps.persistence)
    : undefined;
  const env = deps.env ?? {};
  return async (instanceId) => {
    let values: Record<string, unknown> = {};
    if (repository && instanceId) {
      try {
        const stored = await repository.findRuntimeGovernance(instanceId);
        if (typeof stored === "object" && stored !== null) {
          values = stored as Record<string, unknown>;
        }
      } catch (error) {
        console.warn(
          "[knowledge] 实例设置读取失败，本轮用 env/默认值：",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const num = (key: Parameters<typeof resolveGovernanceNumber>[0]): number =>
      resolveGovernanceNumber(
        key,
        typeof values[key] === "number" ? values[key] : undefined,
        env,
      );
    return {
      autoInject: resolveGovernanceBool(
        "knowledgeAutoInject",
        typeof values.knowledgeAutoInject === "boolean"
          ? values.knowledgeAutoInject
          : undefined,
        env,
      ),
      localMatch: resolveGovernanceBool(
        "knowledgeLocalMatch",
        typeof values.knowledgeLocalMatch === "boolean"
          ? values.knowledgeLocalMatch
          : undefined,
        env,
      ),
      maxResults: num("knowledgeMaxResults"),
      minHits: num("knowledgeMinHits"),
      searchTimeoutMs: num("knowledgeSearchTimeoutMs"),
      maxConcurrentSearches: num("knowledgeMaxConcurrentSearches"),
      evidenceMaxChars: num("knowledgeEvidenceMaxChars"),
      cacheTtlMs: num("knowledgeCacheTtlMs"),
      readMaxBytes: num("knowledgeReadMaxBytes"),
      listTimeoutMs: num("knowledgeListTimeoutMs"),
      listRetries: num("knowledgeListRetries"),
    };
  };
}
