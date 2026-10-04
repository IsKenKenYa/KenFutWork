import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import type {
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";

import type { ServerEnv } from "../../config/env.js";
import { createSupabaseCheckpointer } from "./supabase-checkpointer.js";
import { createSupabaseStore } from "./supabase-store.js";

export type AgentPersistence = {
  checkpointer: BaseCheckpointSaver;
  store: BaseStore;
};

export type AgentPersistenceService = {
  getPersistence(): Promise<AgentPersistence | null>;
};

/**
 * 进程内共享的内存持久化（无 Postgres 时的 fallback）：
 * 单进程内多轮上下文/checkpoint 完整生效，进程重启即失。
 */
function createInMemoryPersistence(): AgentPersistence {
  // 惰性 require 避免 ESM/工具链差异；包在 server 依赖树内必然存在
  return {
    checkpointer: new MemorySaver(),
    store: new InMemoryStore(),
  };
}

export function createAgentPersistenceService(
  env: Pick<ServerEnv, "databaseUrl">,
  overrides?: {
    createCheckpointer?: typeof createSupabaseCheckpointer;
    createStore?: typeof createSupabaseStore;
  },
): AgentPersistenceService {
  let pendingPersistence: Promise<AgentPersistence> | null = null;

  return {
    async getPersistence() {
      if (!env.databaseUrl) {
        // 未配置 Postgres：同一服务实例共享内存持久化，保留 thread 上下文。
        pendingPersistence ??= Promise.resolve(createInMemoryPersistence());
        return pendingPersistence;
      }

      if (!pendingPersistence) {
        pendingPersistence = Promise.all([
          (overrides?.createCheckpointer ?? createSupabaseCheckpointer)({
            connectionString: env.databaseUrl,
          }),
          (overrides?.createStore ?? createSupabaseStore)({
            connectionString: env.databaseUrl,
          }),
        ])
          .then(([checkpointer, store]) => ({ checkpointer, store }))
          .catch(() => {
            // Postgres 不可达：降级为内存实现，保证多轮对话在本机可用
            pendingPersistence = null;
            return createInMemoryPersistence();
          });
      }

      return pendingPersistence;
    },
  };
}
