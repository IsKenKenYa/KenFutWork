/**
 * zcode 照搬：`@/ToolCallBlocks/renderers/ask-question.tsx`（references/zcode/packages/ui/src/ToolCallBlocks/renderers/ask-question.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */

import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import {
  getAskUserQuestionAnswerText,
  normalizeAskUserQuestionInput,
  readAskUserQuestionAnswers,
  readAskUserQuestionInput,
} from "@zui/lib/askUserQuestion";
import type { ToolCallBlockRenderContext } from "@zui/ToolCallBlocks/shared";
import { ToolLayout } from "@zui/ToolCallBlocks/ToolLayout";
import { CircleHelpIcon } from "lucide-react";
import { useCallback } from "react";

const ASK_QUESTION_TOOL_ICON = (
  <CircleHelpIcon className="size-4 shrink-0 text-foreground-subtle" />
);

export function AskQuestionToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText } = context;
  const { toolCall } = toolCallNode;
  const input = readAskUserQuestionInput(toolCall);
  const data = normalizeAskUserQuestionInput(input);
  const answers = readAskUserQuestionAnswers(toolCall) ?? data.answers;
  const wasAutomaticallyContinued =
    !isRunning &&
    toolCall.status !== "failed" &&
    answers !== undefined &&
    Object.keys(answers).length === 0;
  const noAnswerText = intl.formatMessage({
    id: wasAutomaticallyContinued
      ? "chat.askQuestion.autoContinued"
      : "chat.askQuestion.noAnswerProvided",
  });
  const questionCount = data.questions.length;
  const isFailed = toolCall.status === "failed";
  const renderContent = useCallback(
    () =>
      !isRunning || isFailed ? (
        <div className="ml-2 space-y-2 border-l border-border pl-3.5">
          {data.questions.map((question) => (
            <div key={question.id} className="space-y-1">
              <p className="text-ui-base font-medium leading-5 text-foreground">
                {question.question}
              </p>
              <p className="text-ui-base leading-5 text-foreground-subtle">
                {getAskUserQuestionAnswerText(question, answers, noAnswerText)}
              </p>
            </div>
          ))}
          {data.questions.length === 0 ? (
            <p className="text-ui-base leading-5 text-foreground-subtle">
              {noAnswerText}
            </p>
          ) : null}
        </div>
      ) : null,
    [answers, data.questions, isFailed, isRunning, noAnswerText],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={ASK_QUESTION_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={!isRunning}
        forceOpen={false}
        autoOpen={false}
        kindLabel={intl.formatMessage({
          id: isRunning ? "chat.askQuestion.asking" : "chat.askQuestion.asked",
        })}
        sourceLabel={context.sourceLabel}
        primaryText={null}
        secondaryText={
          isRunning
            ? null
            : wasAutomaticallyContinued
              ? noAnswerText
              : intl.formatMessage(
                  { id: "chat.askQuestion.questionsCount" },
                  { count: String(questionCount) },
                )
        }
        statusLabel={isFailed ? statusLabel : undefined}
        statusTooltip={isFailed ? errorText : undefined}
        showFailureStatus={isFailed}
        isRunning={isRunning}
        title={toolCall.title ?? "AskUserQuestion"}
        renderContent={renderContent}
      />
      {/* <pre className="text-[8px]">{JSON.stringify(toolCall, null, 2)}</pre> */}
    </>
  );
}
