/**
 * zcode 宿主适配 stub：`tokenlens` 的 `getUsage` 最小等价。
 * 来源：references/zcode/packages/ui/src/components/ai-elements/context.tsx 的依赖（tokenlens ^1.3.1）
 *
 * tokenlens 的 getUsage 按 modelId 从 models.dev 价目数据折算 token 成本。本仓未引入该依赖
 * （BYOK 形态下成本展示非主链路），这里保持调用签名不变、恒无价目数据：costUSD 恒 undefined，
 * 消费方（ai-elements/context 的 ContextContentFooter / ContextInputUsage / ContextOutputUsage）
 * 按原代码 `costUSD ?? 0` 分支展示 $0.00，UI 结构与降级语义不变。
 * 后续接入真实成本折算时替换本实现即可，照搬组件零改动。
 */

interface GetUsageParams {
  modelId: string;
  /** tokenlens 原签名接受部分用量字段；本仓恒不折算，仅作形状透传。 */
  usage: {
    input?: number;
    output?: number;
    reasoningTokens?: number;
    cacheReads?: number;
  };
}

interface GetUsageResult {
  costUSD?: { totalUSD: number };
}

export function getUsage(_params: GetUsageParams): GetUsageResult {
  return {};
}
