/**
 * zcode 照搬：`@/lib/assistantPreviewCardValidation.ts`（references/zcode/packages/ui/src/lib/assistantPreviewCardValidation.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
import {
  ASSISTANT_PREVIEW_CARD_CANDIDATE_LIMIT,
  ASSISTANT_PREVIEW_CARD_VISIBLE_LIMIT,
  type AssistantPreviewCard,
  type AssistantPreviewCardFileStatService,
  getAssistantPreviewCardFilePath,
  isValidAssistantPreviewWebsiteUrl,
  requiresAssistantPreviewCardFileStat,
} from "@zui/lib/assistantPreviewCards";

export function getAssistantPreviewCardsValidationSignature(
  cards: readonly AssistantPreviewCard[],
): string {
  return cards
    .map((card) => {
      if (card.type === "website") {
        return [
          card.id,
          card.type,
          card.title,
          card.subtitleId,
          card.url,
          card.filePath ?? "",
        ].join("\u0000");
      }

      return [
        card.id,
        card.type,
        card.kind,
        card.title,
        card.subtitleId,
        card.path,
      ].join("\u0000");
    })
    .join("\u0001");
}

export function resolveAssistantPreviewCardsWithoutFileStat(
  cards: readonly AssistantPreviewCard[],
): AssistantPreviewCard[] | null {
  if (cards.some(requiresAssistantPreviewCardFileStat)) {
    return null;
  }

  return cards
    .filter(
      (card) =>
        card.type === "website" && isValidAssistantPreviewWebsiteUrl(card.url),
    )
    .slice(0, ASSISTANT_PREVIEW_CARD_VISIBLE_LIMIT);
}

export async function resolveValidatedAssistantPreviewCards(
  cards: readonly AssistantPreviewCard[],
  fileService: AssistantPreviewCardFileStatService,
): Promise<AssistantPreviewCard[]> {
  const statFreeCards = resolveAssistantPreviewCardsWithoutFileStat(cards);
  if (statFreeCards) {
    return statFreeCards;
  }

  const candidates = cards.slice(0, ASSISTANT_PREVIEW_CARD_CANDIDATE_LIMIT);
  const paths = candidates
    .map(getAssistantPreviewCardFilePath)
    .filter((path): path is string => path !== null);
  const results = await fileService.checkFilesExist({ paths });
  const existingPaths = new Set(
    results.filter((result) => result.exists).map((result) => result.path),
  );

  return candidates
    .filter((card) => {
      if (
        card.type === "website" &&
        !isValidAssistantPreviewWebsiteUrl(card.url)
      ) {
        return false;
      }
      const path = getAssistantPreviewCardFilePath(card);
      return path === null || existingPaths.has(path);
    })
    .slice(0, ASSISTANT_PREVIEW_CARD_VISIBLE_LIMIT);
}
