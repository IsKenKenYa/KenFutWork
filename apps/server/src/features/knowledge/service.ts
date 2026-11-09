/**
 * 安装态动态门控（KB-2 / §2.3 定稿）。
 *
 * 纪律同 `features/computer-use/plugin.ts:9-11,102-141`：**门控在调用时读安装态**，
 * 不在注册期缓存。安装／卸载／停用都是运行期动作，缓存会让「装／卸下一轮即生效」失效。
 * `plugins` 服务本身用 `tryGet` 延迟取，避免装配顺序依赖。
 */

import type { KnowledgeGateVerdict } from "./types.js";
import { KNOWLEDGE_BUNDLE_ID } from "./types.js";

/** 插件注册表的最小结构面（避免与 features/plugins 的具体类型硬耦合）。 */
export interface PluginsServiceLike {
  list(): Promise<
    Array<{ id: string; name: string; installed: boolean; enabled?: boolean }>
  >;
}

export interface KnowledgeGateInspection {
  ok: boolean;
  installed: boolean;
  enabled: boolean;
  /** 失败原因可直接显示给用户；成功为空串。 */
  message: string;
}

export function toGateVerdict(
  inspection: KnowledgeGateInspection,
): KnowledgeGateVerdict {
  return { ok: inspection.ok, message: inspection.message };
}

export function createBundleInspector(
  tryGetPlugins: () => PluginsServiceLike | undefined,
): () => Promise<KnowledgeGateInspection> {
  return async () => {
    const plugins = tryGetPlugins();
    if (!plugins) {
      return {
        ok: false,
        installed: false,
        enabled: false,
        message:
          "插件注册表不可用：无法确认知识库插件安装状态（fail closed）。",
      };
    }
    try {
      const entries = await plugins.list();
      const entry = entries.find(
        (candidate) =>
          candidate.id === KNOWLEDGE_BUNDLE_ID ||
          candidate.name === KNOWLEDGE_BUNDLE_ID,
      );
      if (!entry?.installed) {
        return {
          ok: false,
          installed: false,
          enabled: false,
          message: `知识库插件未安装：请在工作台「插件市场」安装 ${KNOWLEDGE_BUNDLE_ID} 后重试。`,
        };
      }
      if (entry.enabled === false) {
        return {
          ok: false,
          installed: true,
          enabled: false,
          message: "知识库插件已停用：请在「插件市场」重新启用后重试。",
        };
      }
      return { ok: true, installed: true, enabled: true, message: "" };
    } catch (error) {
      return {
        ok: false,
        installed: false,
        enabled: false,
        message: `插件状态查询失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };
}
