/**
 * zcode 照搬：`@/v4/composer/composerPromptContexts.ts`（references/zcode/packages/ui/src/v4/composer/composerPromptContexts.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
import {
  buildPromptWithCodeComments,
  type CodeCommentComposerAttachment,
  parsePromptCodeComments,
} from "@zui/lib/codeCommentContext";
import {
  buildPromptWithConversationSelections,
  type ConversationSelectionDisplayReference,
  parsePromptConversationSelections,
} from "@zui/lib/conversationSelectionReference";
import {
  buildPromptWithPptxElementReferences,
  type PptxElementReference,
  parsePromptPptxElementReferences,
} from "@zui/lib/pptxElementReference";
import {
  buildPromptWithWebElementContexts,
  parsePromptWebElementContexts,
  type WebElementContextComposerAttachment,
} from "@zui/lib/webElementContext";

interface ComposerPromptContexts {
  codeComments: readonly CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: readonly WebElementContextComposerAttachment[];
  pptxElements: readonly PptxElementReference[];
}

export function countComposerPromptContexts(contexts: {
  codeComments: readonly unknown[];
  conversationSelections: readonly unknown[];
  webElements: readonly unknown[];
  pptxElements: readonly unknown[];
}) {
  return (
    contexts.codeComments.length +
    contexts.conversationSelections.length +
    contexts.webElements.length +
    contexts.pptxElements.length
  );
}

/**
 * 四类 context parser 都只识别 prompt 尾块，因此序列化顺序和解析顺序必须严格相反。
 */
export function serializeComposerPromptContexts(
  text: string,
  contexts: ComposerPromptContexts,
): string {
  const withSelections = buildPromptWithConversationSelections(
    text,
    contexts.conversationSelections,
  );
  const withCodeComments = buildPromptWithCodeComments(
    withSelections,
    contexts.codeComments,
  );
  const withWebElements = buildPromptWithWebElementContexts(
    withCodeComments,
    contexts.webElements,
  );
  return buildPromptWithPptxElementReferences(
    withWebElements,
    contexts.pptxElements,
  );
}

export function parseComposerPromptContexts(
  content: string,
  workspace: { workspacePath: string; workspaceIdentity?: string | undefined },
): {
  visibleContent: string;
  codeComments: CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: WebElementContextComposerAttachment[];
  pptxElements: PptxElementReference[];
} {
  const pptx = parsePromptPptxElementReferences(content);
  const web = parsePromptWebElementContexts(pptx.visibleContent, workspace);
  const code = parsePromptCodeComments(web.visibleContent, workspace);
  const selections = parsePromptConversationSelections(code.visibleContent);
  return {
    visibleContent: selections.visibleContent,
    codeComments: code.codeCommentAttachments,
    conversationSelections: selections.references,
    webElements: web.webElementContexts,
    pptxElements: pptx.pptxElementReferences,
  };
}
