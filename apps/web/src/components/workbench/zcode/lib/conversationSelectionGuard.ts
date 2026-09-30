/**
 * zcode 照搬：`@/lib/conversationSelectionGuard.ts`（references/zcode/packages/ui/src/lib/conversationSelectionGuard.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
import { CONVERSATION_SELECTION_MAX_TEXT_LENGTH } from "@zui/lib/conversationSelectionReference";

type ConversationSelectionGuardResult =
  | "eligible"
  | "ineligible"
  | "single-limit";

const CONVERSATION_SELECTION_EXCLUDED_SELECTOR = [
  "button",
  "input",
  "textarea",
  "[role='button']",
  "[role='dialog']",
  "[data-v4-composer-dock]",
  "[data-conversation-selection-tooltip]",
].join(",");

export function hasExcludedConversationSelectionEndpoint(
  startElement: Element | null | undefined,
  endElement: Element | null | undefined,
): boolean {
  return Boolean(
    startElement?.closest(CONVERSATION_SELECTION_EXCLUDED_SELECTOR) ||
      endElement?.closest(CONVERSATION_SELECTION_EXCLUDED_SELECTOR),
  );
}

export function guardConversationSelectionCandidate(input: {
  enabled: boolean;
  sameRow: boolean;
  insideTimeline: boolean;
  excluded: boolean;
  sameSelectableRegion: boolean;
  supportedContent: boolean;
  text: string;
  hasLayout: boolean;
}): ConversationSelectionGuardResult {
  if (
    !input.enabled ||
    !input.sameRow ||
    !input.insideTimeline ||
    input.excluded ||
    !input.sameSelectableRegion ||
    !input.supportedContent ||
    !input.text ||
    !input.hasLayout
  ) {
    return "ineligible";
  }
  return input.text.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH
    ? "single-limit"
    : "eligible";
}
