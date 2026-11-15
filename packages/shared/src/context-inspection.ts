import { z } from "zod";

export const contextMessageSchema = z
  .object({
    type: z.string(),
    data: z.record(z.string(), z.json()),
  })
  .strict();
export const contextRequestInputSchema = z
  .object({
    messages: z.array(z.array(contextMessageSchema)),
    /** 来自 SDK 本次实际 invocation_params；未提供时保持未知。 */
    tools: z.array(z.json()).nullable(),
    model: z.string().nullable(),
  })
  .strict();
export type ContextRequestInput = z.infer<typeof contextRequestInputSchema>;

export const contextRequestUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export const contextRequestSummarySchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    sequence: z.number().int().positive(),
    agentCallId: z.string().nullable(),
    agentName: z.string().nullable(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    model: z.string().nullable(),
    messageCount: z.number().int().nonnegative(),
    toolCount: z.number().int().nonnegative().nullable(),
    inputCharacters: z.number().int().nonnegative(),
    outputCharacters: z.number().int().nonnegative().nullable(),
    usage: contextRequestUsageSchema.nullable(),
  })
  .strict();
export type ContextRequestSummary = z.infer<typeof contextRequestSummarySchema>;

export const contextRequestListInputSchema = z
  .object({
    taskId: z.uuid(),
    before: z.number().int().positive().optional(),
  })
  .strict();
export const contextRequestListSchema = z
  .object({
    requests: z.array(contextRequestSummarySchema),
    nextBefore: z.number().int().positive().nullable(),
  })
  .strict();
export const contextRequestReadInputSchema = z
  .object({
    taskId: z.uuid(),
    requestId: z.uuid(),
    part: z.enum(["input", "output"]),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();
export const contextRequestPageSchema = z
  .object({
    text: z.string(),
    nextOffset: z.number().int().nonnegative().nullable(),
    totalCharacters: z.number().int().nonnegative(),
  })
  .strict();
