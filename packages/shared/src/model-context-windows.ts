/**
 * 常见模型族的**上下文窗口兜底表**。
 *
 * 为什么需要它：上下文容量要显示「当前占用 / 模型窗口（百分比）」，而供应商实例的模型清单
 * 里经常没声明 `contextWindow`（BYOK 实例尤其如此）——不兜底就只剩一个问号，
 * 用户等于是看不到任何数字。**声明的值永远优先**（实例里能写 `contextWindow`），
 * 这张表只在没声明时提供一个公开的常见值。
 *
 * 口径：按模型 id 前缀/关键字匹配常见族；匹配不到返回 null（界面按「窗口未知」处理，
 * 不编造数字）。数字来自各家的公开文档，改动请连同 `docs/tech/改造计划.md` §4.13 一起记。
 */

const PATTERNS: Array<{ test: RegExp; window: number }> = [
  // OpenAI
  { test: /^gpt-4\.1/i, window: 1_047_576 },
  { test: /^gpt-5/i, window: 400_000 },
  { test: /^gpt-4o|^gpt-4-turbo|^gpt-4\.5/i, window: 128_000 },
  { test: /^o[1-4](-|$)/i, window: 200_000 },
  // Anthropic
  { test: /^claude/i, window: 200_000 },
  // Google
  { test: /^gemini/i, window: 1_048_576 },
  // 智谱 GLM：4.5/4.6 公开 200k，5.x 公开 1M
  { test: /^glm-5/i, window: 1_000_000 },
  { test: /^glm/i, window: 200_000 },
  // DeepSeek：v3.x 128k，v4 起 1M
  { test: /^deepseek-v4|^deepseek-chat-v4/i, window: 1_000_000 },
  { test: /^deepseek/i, window: 128_000 },
  // 阿里 Qwen：131072
  { test: /^qwen/i, window: 131_072 },
  // 月之暗面 Kimi：131072
  { test: /^kimi|^moonshot/i, window: 131_072 },
  // MiniMax：1M
  { test: /^minimax|^abab/i, window: 1_000_000 },
  // 字节豆包：256k
  { test: /^doubao|^seed/i, window: 256_000 },
  // 讯飞星火：128k
  { test: /^spark|^generalv/i, window: 128_000 },
];

/** 兜底查表：认不出返回 null（不编数字）。 */
export function knownContextWindow(modelId: string): number | null {
  const id = modelId.trim();
  if (!id) return null;
  // BYOK 的模型 id 可能带实例前缀（`<instanceId>:<model>`），取冒号后的模型名
  const bare = id.includes(":") ? (id.split(":").pop() ?? id) : id;
  for (const pattern of PATTERNS) {
    if (pattern.test.test(bare)) return pattern.window;
  }
  return null;
}

/** 上下文窗口：**声明优先**，没声明用兜底表，都没有返回 null。 */
export function resolveContextWindow(
  declared: number | null | undefined,
  modelId: string,
): number | null {
  if (typeof declared === "number" && declared > 0) return declared;
  return knownContextWindow(modelId);
}
