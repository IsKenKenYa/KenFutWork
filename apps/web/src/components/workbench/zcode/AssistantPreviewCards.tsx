/**
 * zcode 照搬：`@/AssistantPreviewCards.tsx`（references/zcode/packages/ui/src/AssistantPreviewCards.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件接口可选属性放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 */

import type { MessageFileLinkTarget } from "@zui/components/ai-elements/message";
import { useWorkspaceServices } from "@zui/hooks/useWorkspaceServices";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import {
  type AssistantPreviewCard,
  type AssistantPreviewCardFileStatService,
  type AssistantPreviewCardsAutoOpenRequest,
  getAssistantPreviewCardFilePath,
  shouldOpenAssistantHtmlInBrowser,
} from "@zui/lib/assistantPreviewCards";
import {
  getAssistantPreviewCardsValidationSignature,
  resolveAssistantPreviewCardsWithoutFileStat,
  resolveValidatedAssistantPreviewCards,
} from "@zui/lib/assistantPreviewCardValidation";
import type { CodeViewerSource } from "@zui/lib/codeViewer";
import {
  FileDisplayIcon,
  resolveFileDisplayDescriptor,
} from "@zui/lib/fileDisplay";
import { OpenSplitButton } from "@zui/OpenSplitButton";
import { FileTextIcon, GlobeIcon } from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface AssistantPreviewCardValidationResult {
  visibleCards: AssistantPreviewCard[];
  settled: boolean;
}

function buildAssistantPreviewCardFileSource(
  card: Extract<AssistantPreviewCard, { type: "markdown" | "file" }>,
  scope: {
    workspacePath?: string | undefined;
    workspaceIdentity?: string | undefined;
    workspaceRemoteSessionId?: string | undefined;
  },
): CodeViewerSource {
  return {
    type: "file",
    title: card.title,
    path: card.path,
    ...(scope.workspacePath ? { workspacePath: scope.workspacePath } : {}),
    ...(scope.workspaceIdentity
      ? { workspaceIdentity: scope.workspaceIdentity }
      : {}),
    ...(scope.workspaceRemoteSessionId
      ? { workspaceRemoteSessionId: scope.workspaceRemoteSessionId }
      : {}),
  };
}

function buildAssistantPreviewPptxAutoOpenRequest(
  visibleCards: readonly AssistantPreviewCard[],
  baseKey: string,
  scope: {
    workspacePath?: string | undefined;
    workspaceIdentity?: string | undefined;
    workspaceRemoteSessionId?: string | undefined;
  },
): AssistantPreviewCardsAutoOpenRequest | null {
  const pptxCards = visibleCards.filter(
    (card): card is Extract<AssistantPreviewCard, { type: "file" }> =>
      card.type === "file" && card.kind === "pptx",
  );
  if (pptxCards.length === 0) return null;

  return {
    // stat 结果对应的最终卡片签名必须进入一次性 key；同一 turn 的候选若晚到，
    // 不会把旧的校验投影误当成已经消费的新结果。
    key: JSON.stringify([
      baseKey,
      getAssistantPreviewCardsValidationSignature(pptxCards),
    ]),
    sources: pptxCards.map((card) =>
      buildAssistantPreviewCardFileSource(card, scope),
    ),
  };
}

interface AssistantPreviewCardsProps {
  cards: AssistantPreviewCard[];
  workspacePath?: string | undefined;
  workspaceIdentity?: string | undefined;
  workspaceRemoteSessionId?: string | undefined;
  onOpenBrowserUrl?: ((url: string) => void | undefined) | undefined;
  onOpenFileLink?:
    | ((target: MessageFileLinkTarget) => void | undefined)
    | undefined;
  onOpenCodeViewer?:
    | ((source: CodeViewerSource) => void | undefined)
    | undefined;
  /** Desktop 完成态生成产物：批量打开本轮已通过校验的 PPTX。 */
  autoOpenPptxKey?: string | undefined;
  onAutoOpenPptx?:
    | ((request: AssistantPreviewCardsAutoOpenRequest) => void | undefined)
    | undefined;
}

function shouldRenderAssistantPreviewCardAsFile(
  card: AssistantPreviewCard,
  scope: {
    workspaceIdentity?: string | undefined;
    workspaceRemoteSessionId?: string | undefined;
  },
): boolean {
  const filePath = getAssistantPreviewCardFilePath(card);
  return (
    card.type !== "website" ||
    (card.url.startsWith("file://") &&
      filePath !== null &&
      !shouldOpenAssistantHtmlInBrowser({ path: filePath, ...scope }))
  );
}

function useAssistantPreviewCardValidation(
  cards: AssistantPreviewCard[],
  scope: {
    workspacePath?: string | undefined;
    workspaceIdentity?: string | undefined;
    workspaceRemoteSessionId?: string | undefined;
  } = {},
): AssistantPreviewCardValidationResult {
  const { fileService } = useWorkspaceServices(
    scope.workspacePath,
    scope.workspaceRemoteSessionId,
    scope.workspaceIdentity,
  );
  const cardsSignature = useMemo(
    () => getAssistantPreviewCardsValidationSignature(cards),
    [cards],
  );
  const validationCardsRef = useRef({ cards, signature: cardsSignature });
  // timeline 重建时会传入内容相同但引用不同的 cards 数组，effect 若依赖数组引用会重复发起 RPC。
  // 只在语义签名变化时替换校验快照；workspace fileService 变化仍会使用同一快照重新校验。
  if (validationCardsRef.current.signature !== cardsSignature) {
    validationCardsRef.current = { cards, signature: cardsSignature };
  }
  const validationCards = validationCardsRef.current.cards;
  const statFreeVisibleCards = useMemo(
    () => resolveAssistantPreviewCardsWithoutFileStat(validationCards),
    [validationCards],
  );
  const [validationResult, setValidationResult] = useState<{
    fileService: AssistantPreviewCardFileStatService | null | undefined;
    signature: string;
    visibleCards: AssistantPreviewCard[];
  }>(() => ({
    fileService: null,
    signature: "",
    visibleCards: [],
  }));

  useEffect(() => {
    if (statFreeVisibleCards) {
      return;
    }

    let disposed = false;

    // 历史消息切换时，上一条消息的已通过 stat 结果会在 effect 清理前短暂复用。
    // 这里按当前候选签名批量二次校验，全部算完后一次发布，避免文件卡先闪一批再被替换。
    // 适配注记（P9）：宿主 stub 下 fileService 可为 undefined；类型位按非空断言收窄，
    // 运行时 stat 调用在 undefined 上抛错走下方 rejection 分支（可见卡清空），降级语义不变。
    void resolveValidatedAssistantPreviewCards(
      validationCards,
      fileService as AssistantPreviewCardFileStatService,
    ).then(
      (visibleCards) => {
        if (disposed) return;
        setValidationResult({
          fileService,
          signature: cardsSignature,
          visibleCards,
        });
      },
      () => {
        if (disposed) return;
        setValidationResult({
          fileService,
          signature: cardsSignature,
          visibleCards: [],
        });
      },
    );

    return () => {
      disposed = true;
    };
  }, [cardsSignature, fileService, statFreeVisibleCards, validationCards]);

  if (statFreeVisibleCards) {
    return {
      visibleCards: statFreeVisibleCards,
      settled: true,
    };
  }

  const hasCurrentValidation =
    validationResult.fileService === fileService &&
    validationResult.signature === cardsSignature;

  return {
    visibleCards: hasCurrentValidation ? validationResult.visibleCards : [],
    settled: hasCurrentValidation,
  };
}

export function AssistantPreviewCards({
  cards,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  autoOpenPptxKey,
  onAutoOpenPptx,
}: AssistantPreviewCardsProps) {
  const { intl } = useZCodeIntl();
  const { visibleCards, settled } = useAssistantPreviewCardValidation(cards, {
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });

  useEffect(() => {
    if (!settled || !autoOpenPptxKey || !onAutoOpenPptx) return;

    const request = buildAssistantPreviewPptxAutoOpenRequest(
      visibleCards,
      autoOpenPptxKey,
      {
        workspacePath,
        workspaceIdentity,
        workspaceRemoteSessionId,
      },
    );
    if (!request) return;

    // 自动打开只能消费最终可见卡片；这样与 15 个候选、10 张上限和 Host stat
    // 完全同源，不会打开卡片中并不存在的文件。
    onAutoOpenPptx(request);
  }, [
    autoOpenPptxKey,
    onAutoOpenPptx,
    settled,
    visibleCards,
    workspaceIdentity,
    workspacePath,
    workspaceRemoteSessionId,
  ]);

  if (!settled || visibleCards.length === 0) {
    return null;
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {visibleCards.map((card, index) => (
        <AssistantPreviewCardRow
          key={card.id}
          card={card}
          animationDelayMs={Math.min(index * 36, 240)}
          subtitle={intl.formatMessage({ id: card.subtitleId })}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          workspaceRemoteSessionId={workspaceRemoteSessionId}
          onOpenBrowserUrl={onOpenBrowserUrl}
          onOpenFileLink={onOpenFileLink}
          onOpenCodeViewer={onOpenCodeViewer}
        />
      ))}
    </div>
  );
}

function AssistantPreviewCardRow({
  card,
  animationDelayMs,
  subtitle,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
}: {
  card: AssistantPreviewCard;
  animationDelayMs: number;
  subtitle: string;
  workspacePath?: string | undefined;
  workspaceIdentity?: string | undefined;
  workspaceRemoteSessionId?: string | undefined;
  onOpenBrowserUrl?: ((url: string) => void | undefined) | undefined;
  onOpenFileLink?:
    | ((target: MessageFileLinkTarget) => void | undefined)
    | undefined;
  onOpenCodeViewer?:
    | ((source: CodeViewerSource) => void | undefined)
    | undefined;
}) {
  const filePath = getAssistantPreviewCardFilePath(card);
  const renderAsFile = shouldRenderAssistantPreviewCardAsFile(card, {
    workspaceIdentity,
    workspaceRemoteSessionId,
  });
  const descriptor = filePath ? resolveFileDisplayDescriptor(filePath) : null;
  const fileSource =
    renderAsFile && filePath
      ? {
          type: "file" as const,
          title: card.title,
          path: filePath,
          ...(workspacePath ? { workspacePath } : {}),
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
        }
      : null;
  return (
    <div
      className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 pr-4 text-foreground"
      data-zcode-stream-animate="true"
      style={
        {
          "--zcode-stream-animation-delay": `${animationDelayMs}ms`,
        } as CSSProperties
      }
    >
      <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-background text-foreground-subtle">
        {!renderAsFile && card.type === "website" ? (
          <GlobeIcon className="size-6" />
        ) : descriptor ? (
          <FileDisplayIcon src={descriptor.fileIconSrc} size={24} />
        ) : (
          <FileTextIcon className="size-6" />
        )}
      </div>
      <div className="min-w-0 flex flex-1 flex-col gap-1">
        <div className="truncate text-ui-base font-medium leading-5">
          {card.title}
        </div>
        <div className="truncate text-ui-base leading-5 text-foreground-subtlest">
          {subtitle}
        </div>
      </div>
      <OpenSplitButton
        target={
          !renderAsFile && card.type === "website"
            ? {
                type: "website",
                url: card.url,
                // website 卡有两个来源——html 引用卡（file://）与 localhost
                // 预览卡（http(s) 活服务）。localPath 直开只对前者生效；localhost 卡
                // 必须继续把 URL 交给浏览器，否则丢路由/动态内容。
                localPath: card.url.startsWith("file:")
                  ? card.filePath
                  : undefined,
              }
            : {
                type: "file",
                path: filePath!,
                title: card.title,
                label: card.title,
                // Preview Card 以前没有 CodeViewer scope，远程 Linux path
                // 会被 OpenSplitButton 当成本地路径交给宿主编辑器。
                previewSource:
                  card.type === "website"
                    ? fileSource!
                    : buildAssistantPreviewCardFileSource(card, {
                        workspacePath,
                        workspaceIdentity,
                        workspaceRemoteSessionId,
                      }),
              }
        }
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenFileLink={onOpenFileLink}
        onOpenCodeViewer={onOpenCodeViewer}
      />
    </div>
  );
}
