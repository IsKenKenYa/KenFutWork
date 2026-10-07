import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import type {
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";
import type { ServerEnv } from "../../config/env.js";
import { createResourceDisposer } from "../../kernel/disposal.js";
import { createSupabaseCheckpointer } from "./supabase-checkpointer.js";
import { createSupabaseStore } from "./supabase-store.js";

export type AgentPersistence = {
  checkpointer: BaseCheckpointSaver;
  store: BaseStore;
};

export type AgentPersistenceService = {
  getPersistence(): Promise<AgentPersistence | null>;
  dispose(): Promise<void>;
};

type ManagedPersistence = {
  value: AgentPersistence;
  dispose(): Promise<void>;
};

/** 仅未配置Postgres时使用；同一服务共享上下文，进程重启即失。 */
function createInMemoryPersistence(): ManagedPersistence {
  return {
    value: { checkpointer: new MemorySaver(), store: new InMemoryStore() },
    dispose: async () => {},
  };
}

export function createAgentPersistenceService(
  env: Pick<ServerEnv, "databaseUrl">,
  overrides?: {
    createCheckpointer?: typeof createSupabaseCheckpointer;
    createStore?: typeof createSupabaseStore;
  },
): AgentPersistenceService {
  let pendingPersistence: Promise<ManagedPersistence> | null = null;
  let closing = false;
  let disposal: Promise<void> | undefined;

  async function initialize(): Promise<ManagedPersistence> {
    const connectionString = env.databaseUrl;
    if (!connectionString) return createInMemoryPersistence();
    // 两个SDK共享schema；顺序初始化，同时明确持有部分成功的资源。
    const checkpointer = await (
      overrides?.createCheckpointer ?? createSupabaseCheckpointer
    )({ connectionString });
    try {
      const store = await (overrides?.createStore ?? createSupabaseStore)({
        connectionString,
      });
      return {
        value: { checkpointer, store },
        dispose: createResourceDisposer([
          () => checkpointer.end(),
          () => store.stop(),
        ]),
      };
    } catch (error) {
      await checkpointer.end();
      throw error;
    }
  }

  return {
    async getPersistence() {
      if (closing) throw new Error("Agent持久化服务已关闭");
      pendingPersistence ??= initialize().catch((error: unknown) => {
        // 已承诺数据库持久化时必须显式失败；待资源释放后下一次读取可以重试。
        pendingPersistence = null;
        throw error;
      });
      const persistence = await pendingPersistence;
      if (closing) throw new Error("Agent持久化服务已关闭");
      return persistence.value;
    },
    dispose() {
      closing = true;
      // 未使用的服务关闭时不初始化；已失败的初始化由各Provider完成部分清理。
      disposal ??= (async () => {
        const persistence = await pendingPersistence?.catch(() => null);
        await persistence?.dispose();
      })().catch((error: unknown) => {
        disposal = undefined;
        throw error;
      });
      return disposal;
    },
  };
}
