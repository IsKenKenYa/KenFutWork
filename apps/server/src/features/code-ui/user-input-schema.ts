// SPDX-License-Identifier: Apache-2.0
// AskUserQuestion contract adapted from ZCode, commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e.
// Source: apps/zcode-cli/packages/contracts/src/tools/ask-user-question.ts.
// Original license: references/zcode/LICENSE (Apache-2.0).
// Changes: Zod 4 record syntax and local exports; collection happens in our bound broker,
// rather than modifying model input in ZCode's permission scheduler. No timeout is copied.
import { z } from "zod";

export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

const htmlMarker = /<!doctype\b|<!--|<\/?\s*[a-z][a-z0-9:-]*(?:\s[^<>]*)?>/i;
const htmlTag = /<\/?\s*[a-z][a-z0-9:-]*(?:\s[^<>]*)?>/i;

const optionSchema = z
  .object({
    label: z.string().describe("A concise choice label; clients add Other."),
    description: z.string().describe("The choice's meaning and tradeoffs."),
    preview: z.string().optional(),
  })
  .strict()
  .superRefine((option, context) => {
    const preview = option.preview;
    if (preview === undefined || !htmlMarker.test(preview)) return;
    if (/<!doctype\b|<\/?\s*(?:html|body)\b/i.test(preview))
      context.addIssue({
        code: "custom",
        message:
          "HTML preview must be a fragment without html, body, or doctype",
        path: ["preview"],
      });
    if (/<\/?\s*(?:script|style)\b/i.test(preview))
      context.addIssue({
        code: "custom",
        message: "HTML preview cannot contain script or style tags",
        path: ["preview"],
      });
    if (!htmlTag.test(preview))
      context.addIssue({
        code: "custom",
        message: "HTML preview must contain an HTML tag",
        path: ["preview"],
      });
  });

// 1–4题、2–4选项是原Ask工具协议的结构约束，不是执行次数或超时限额。
export const askUserQuestionSchema = z
  .object({
    question: z.string().describe("The complete clarification question."),
    header: z.string().describe("A short display label for this question."),
    options: z.array(optionSchema).min(2).max(4),
    multiSelect: z.boolean().default(false),
  })
  .strict()
  .superRefine((question, context) => {
    const labels = question.options.map((option) => option.label);
    if (new Set(labels).size !== labels.length)
      context.addIssue({
        code: "custom",
        message: "Option labels must be unique within each question",
        path: ["options"],
      });
    if (labels.some((label) => label.trim().toLowerCase() === "other"))
      context.addIssue({
        code: "custom",
        message:
          "Do not include an Other option; clients provide it automatically",
        path: ["options"],
      });
  });

export const askUserQuestionAnnotationSchema = z
  .object({ preview: z.string().optional(), notes: z.string().optional() })
  .strict();

export const askUserQuestionInputSchema = z
  .object({
    questions: z.array(askUserQuestionSchema).min(1).max(4),
    answers: z.record(z.string(), z.string()).optional(),
    annotations: z
      .record(z.string(), askUserQuestionAnnotationSchema)
      .optional(),
    metadata: z.object({ source: z.string().optional() }).strict().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const texts = input.questions.map((question) => question.question);
    if (new Set(texts).size !== texts.length)
      context.addIssue({
        code: "custom",
        message: "Question texts must be unique",
        path: ["questions"],
      });
  });

export const askUserQuestionOutputSchema = z
  .object({
    questions: z.array(askUserQuestionSchema).min(1).max(4),
    answers: z.record(z.string(), z.string()),
    annotations: z
      .record(z.string(), askUserQuestionAnnotationSchema)
      .optional(),
  })
  .strict();

export type AskUserQuestionInput = z.infer<typeof askUserQuestionInputSchema>;
export type AskUserQuestionOutput = z.infer<typeof askUserQuestionOutputSchema>;

/** Model-prepopulated answers remain valid input, but are not human facts. */
export function projectAskUserQuestionInput(input: AskUserQuestionInput) {
  return {
    questions: structuredClone(input.questions),
    ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
  };
}
