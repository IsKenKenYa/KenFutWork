import {
  type InstanceSettings,
  resolveGovernanceNumber,
} from "@kenfutwork/shared";

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
 * **③ 历史对齐**：压缩**不动用户看到的转录**——被压掉的消息保留于精确的
 * 产品只读checkpoint归档，模型上下文里替换成一条摘要（`lc_source="summarization"` 的
 * HumanMessage）。转录仍是完整历史（与 Claude Code 一类产品同口径：库里留全量，
 * 上下文里留摘要），因此「库里消息数」与「模型看到的上下文」本来就会不一致——这是
 * **设计**，不是 bug；界面上用一条提示说明发生了什么（见 stream-adapter 的 notice）。
 *
 * 近期原文按消息数设置保留目标，默认值与护栏由 shared governance 持有；
 * 已知/未知窗口的目标均由实例设置控制，SDK 可为工具配对或溢出恢复调整实际尾部。
 */

/** deepagents 的框架约定（不自己发明数字，改这里必须同步核对依赖版本）。 */
export const FRAMEWORK_TRIGGER_FRACTION = 0.85;
export const FRAMEWORK_FALLBACK_TRIGGER_TOKENS = 170_000;

/** Product-owned hard input budget for the current frozen model, separate from an earlier compaction trigger. */
export interface AgentContextBudget {
  inputTokenLimit: number | null;
}

export interface CompactionPlan {
  trigger: { type: "tokens"; value: number };
  keep: { type: "messages"; value: number };
  /** 阈值是怎么来的（写进日志/事件，便于真机排查「为什么这么早就压了」）。 */
  source: "reserved-output" | "fraction" | "fallback";
}

export type CompactionRetention = Pick<
  InstanceSettings,
  "compactKeepMessages" | "compactFallbackKeepMessages"
>;

/**
 * 算压缩触发线。
 *
 * `reserve` = 本轮实际wire的单次输出上限（与上下文条的「预留输出」段同一口径）：
 * 它是**为回复留的空间**，已经吃掉它就意味着下一轮回复可能被上游截断——压缩要在这之前发生。
 */
function budgetNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : null;
}

/** Shared current-model input cap; unknown output consumes no invented reserve, unknown window has no hard cap. */
export function resolveInputTokenLimit(input: {
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}): number | null {
  const window = budgetNumber(input.contextWindow);
  if (window === null) return null;
  const output = budgetNumber(input.maxOutputTokens);
  if (output !== null && output >= window)
    throw new Error("模型输出上限已占满上下文，请降低输出上限。");
  return window - (output ?? 0);
}

export function resolveCompactionPlan(input: {
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  retention?: CompactionRetention;
}): CompactionPlan {
  const window = budgetNumber(input.contextWindow);
  const maxOutput = budgetNumber(input.maxOutputTokens);
  const inputLimit = resolveInputTokenLimit(input);

  if (window === null) {
    return {
      trigger: { type: "tokens", value: FRAMEWORK_FALLBACK_TRIGGER_TOKENS },
      keep: {
        type: "messages",
        value: resolveGovernanceNumber(
          "compactFallbackKeepMessages",
          input.retention?.compactFallbackKeepMessages,
        ),
      },
      source: "fallback",
    };
  }

  const value =
    maxOutput === null
      ? Math.floor(window * FRAMEWORK_TRIGGER_FRACTION)
      : (inputLimit ?? window);

  return {
    trigger: { type: "tokens", value: Math.max(1, value) },
    keep: {
      type: "messages",
      value: resolveGovernanceNumber(
        "compactKeepMessages",
        input.retention?.compactKeepMessages,
      ),
    },
    source: maxOutput === null ? "fraction" : "reserved-output",
  };
}
