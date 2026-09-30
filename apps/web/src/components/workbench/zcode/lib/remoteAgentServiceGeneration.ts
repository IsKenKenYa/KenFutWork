/**
 * zcode 照搬：`@/lib/remoteAgentServiceGeneration.ts`（references/zcode/packages/ui/src/lib/remoteAgentServiceGeneration.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */
// Remote workspace service proxy 的 renderer-local 单调代际。
// session 注册入口先预分配，异步 consumer 再按对象身份读取同一代际，避免 effect 乱序回切。
const generations = new WeakMap<object, number>();
let nextGeneration = 1;

export function remoteAgentServiceGeneration(agentService: object): number {
  const existing = generations.get(agentService);
  if (existing !== undefined) return existing;

  const generation = nextGeneration++;
  generations.set(agentService, generation);
  return generation;
}
