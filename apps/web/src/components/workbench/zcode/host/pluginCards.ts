import {
  type PluginCardDeclaration,
  type PluginMarketEntry,
  pluginMarketListResponseSchema,
} from "@kenfutwork/shared";
import type { CodeHttpChannelClient } from "./httpChannelClient.js";

/**
 * 插件声明式卡片的宿主持有处：启动时读取插件列表，只收集已安装且已启用条目的卡片；
 * 插件库存变化时重读，已渲染的工具卡随版本号重新选择渲染器。
 * 卡片是纯数据（工具名、标题、键值行、状态），渲染由本机宿主完成，不改 Code 壳源码。
 */
let snapshot: readonly PluginCardDeclaration[] = [];
let version = 0;
const listeners = new Set<() => void>();

export function collectPluginCards(
  plugins: readonly PluginMarketEntry[],
): PluginCardDeclaration[] {
  return plugins
    .filter((plugin) => plugin.installed && plugin.enabled)
    .flatMap((plugin) => plugin.cards);
}

export async function loadPluginCards(
  client: Pick<CodeHttpChannelClient, "request">,
): Promise<void> {
  try {
    const raw = await client.request<unknown>("/api/plugins");
    const parsed = pluginMarketListResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error("插件列表格式不符");
    snapshot = collectPluginCards(parsed.data.plugins);
    version += 1;
    for (const listener of listeners) listener();
  } catch (error) {
    // 卡片只是工具卡的附加显示；读取失败保留上一次快照，不拦工作台使用，但如实记录原因。
    console.warn("[code-ui] 插件卡片声明读取失败：", error);
  }
}

export function getPluginCardsSnapshot(): readonly PluginCardDeclaration[] {
  return snapshot;
}

export function getPluginCardsVersion(): number {
  return version;
}

export function subscribePluginCards(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function findPluginCard(
  toolName: string | null | undefined,
): PluginCardDeclaration | null {
  if (!toolName) return null;
  return (
    snapshot.find((card) => card.tools.includes(toolName)) ?? null
  );
}
