/**
 * zcode 照搬：`@/AssistantCodeCommentFeatureProvider.tsx`（references/zcode/packages/ui/src/AssistantCodeCommentFeatureProvider.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
import { createContext, type ReactNode, useContext } from "react";

const DEFAULT_ASSISTANT_CODE_COMMENT_CARDS_ENABLED = false;
const AssistantCodeCommentFeatureContext = createContext(
  DEFAULT_ASSISTANT_CODE_COMMENT_CARDS_ENABLED,
);

export function AssistantCodeCommentFeatureProvider({
  children,
  enabled = DEFAULT_ASSISTANT_CODE_COMMENT_CARDS_ENABLED,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  return (
    <AssistantCodeCommentFeatureContext.Provider value={enabled}>
      {children}
    </AssistantCodeCommentFeatureContext.Provider>
  );
}

export function useAssistantCodeCommentFeatureEnabled(): boolean {
  return useContext(AssistantCodeCommentFeatureContext);
}
