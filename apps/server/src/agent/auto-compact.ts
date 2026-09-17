/**
 * 上下文自动压缩的**口径**（R4-1 的「输出预留线」在这里有了执行面）。
 *
 * ## 定下来的三件事
 *
 * **① 阈值**：默认取「窗口 − 预留输出」，也就是上下文条上那根**输出预留线**——
 * 界面上写的那条线和实际压缩点必须是同一个数，否则用户按界面判断「还早」，模型那边
 * 已经在丢历史了。两种退化情形按框架自己的约定走（不自己发明数字）：
 * - 窗口已知、模型没声明最大输出 → `window × 0.85`（deepagents `PROFILE_TRIGGER = fraction 0.85`）；
 * - 窗口未知（既没声明也认不出模型族） → `170_000` tokens（deepagents `FALLBACK_TRIGGER`）。
 *
 * **② 摘要模型**：**不引入第二个模型配置**——用本轮 run 的模型（BYOK 场景下就是用户
 * 自己那把 Key）。理由：多配一个「摘要专用模型」意味着多一份凭证/费用/可用性耦合，
 * 而压缩是运行期的自保动作，不该因为第二个模型没配好就失败。
 *
 * **③ 历史对齐**：压缩**不动用户看到的转录**——被压掉的消息由框架 offload 到工作区的
 * `/conversation_history/`，模型上下文里替换成一条摘要（`lc_source="summarization"` 的
 * HumanMessage）。转录仍是完整历史（与 Claude Code 一类产品同口径：库里留全量，
 * 上下文里留摘要），因此「库里消息数」与「模型看到的上下文」本来就会不一致——这是
 * **设计**，不是 bug；界面上用一条提示说明发生了什么（见 stream-adapter 的 notice）。
 *
 * 保留条数固定 20 条（框架文档里的 keep 默认），不用百分比——条数可控、可预测。
 */

/** deepagents 的框架约定（不自己发明数字，改这里必须同步核对依赖版本）。 */
export const FRAMEWORK_TRIGGER_FRACTION = 0.85;
export const FRAMEWORK_FALLBACK_TRIGGER_TOKENS = 170_000;
export const FRAMEWORK_FALLBACK_KEEP_MESSAGES = 6;
/** 我们的保留条数（框架 d.ts 的 keep 默认值）。 */
export const KEEP_MESSAGES = 20;
/** 触发线的下限：窗口很小的模型也不能一上来就压（避免病态配置把每轮都压一遍）。 */
export const MIN_TRIGGER_TOKENS = 4_000;

export interface CompactionPlan {
  trigger: { type: "tokens"; value: number };
  keep: { type: "messages"; value: number };
  /** 阈值是怎么来的（写进日志/事件，便于真机排查「为什么这么早就压了」）。 */
  source: "reserved-output" | "fraction" | "fallback";
}

/**
 * 算压缩触发线。
 *
 * `reserve` = 模型声明的单次最大输出（与上下文条的「预留输出」段同一口径）：
 * 它是**为回复留的空间**，已经吃掉它就意味着下一轮回复可能被上游截断——压缩要在这之前发生。
 */
export function resolveCompactionPlan(input: {
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}): CompactionPlan {
  const window =
    typeof input.contextWindow === "number" &&
    Number.isFinite(input.contextWindow) &&
    input.contextWindow > 0
      ? Math.floor(input.contextWindow)
      : null;
  const maxOutput =
    typeof input.maxOutputTokens === "number" &&
    Number.isFinite(input.maxOutputTokens) &&
    input.maxOutputTokens > 0
      ? Math.floor(input.maxOutputTokens)
      : null;

  if (window === null) {
    return {
      trigger: { type: "tokens", value: FRAMEWORK_FALLBACK_TRIGGER_TOKENS },
      keep: { type: "messages", value: FRAMEWORK_FALLBACK_KEEP_MESSAGES },
      source: "fallback",
    };
  }

  const value =
    maxOutput === null
      ? Math.floor(window * FRAMEWORK_TRIGGER_FRACTION)
      : window - Math.min(maxOutput, window);

  return {
    trigger: { type: "tokens", value: Math.max(MIN_TRIGGER_TOKENS, value) },
    keep: { type: "messages", value: KEEP_MESSAGES },
    source: maxOutput === null ? "fraction" : "reserved-output",
  };
}
