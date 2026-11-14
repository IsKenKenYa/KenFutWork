import { z } from "zod";

/** 原生 Helper 的协议版本。字段改义或删除时必须提升。 */
export const COMPUTER_USE_HELPER_PROTOCOL_VERSION = 1 as const;

export const computerUseHelperPermissionStateSchema = z.enum([
  "granted",
  "stale",
  "denied",
  "unknown",
]);

export const computerUseHelperScreenRecordingStateSchema = z.enum([
  "granted",
  "denied",
  "unknown",
]);

export const computerUseHelperPermissionStatusSchema = z
  .object({
    available: z.boolean(),
    helperBundleId: z.string().min(1),
    helperPath: z
      .string()
      .min(1)
      .refine((value) => value.startsWith("/"), "Helper 路径必须是绝对路径"),
    teamIdentifier: z.string().min(1).nullable(),
    accessibility: computerUseHelperPermissionStateSchema,
    screenRecording: computerUseHelperScreenRecordingStateSchema,
    automation: z.enum(["granted", "denied", "unknown"]).optional(),
    accessibilityProbeOk: z.boolean().optional(),
    screenCaptureProbeOk: z.boolean().optional(),
    grantOwner: z.string().min(1).nullable(),
    reason: z.string().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.grantOwner !== null &&
      value.grantOwner !== value.helperBundleId &&
      value.grantOwner !== value.helperPath
    )
      context.addIssue({
        code: "custom",
        message: "grantOwner 必须指向 Helper 身份，不能是主应用或 Node",
        path: ["grantOwner"],
      });
  });

export const computerUseHelperHelloParamsSchema = z
  .object({
    protocolVersion: z.literal(COMPUTER_USE_HELPER_PROTOCOL_VERSION),
    client: z.string().min(1),
    clientVersion: z.string().min(1),
    /** 32 字节随机 token，以 64 位小写十六进制字符串传递。 */
    token: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const computerUseHelperHelloResultSchema = z
  .object({
    protocolVersion: z.literal(COMPUTER_USE_HELPER_PROTOCOL_VERSION),
    helperVersion: z.string().min(1),
    bundleId: z.string().min(1),
    pid: z.number().int().positive(),
    teamIdentifier: z.string().min(1).nullable(),
    permissions: z
      .object({
        accessibility: computerUseHelperPermissionStateSchema,
        screenRecording: computerUseHelperScreenRecordingStateSchema,
      })
      .strict(),
  })
  .strict();

export const computerUseHelperPermissionRequestKindSchema = z.enum([
  "accessibility",
  "screen_recording",
]);

export const computerUseHelperPermissionStatusParamsSchema = z
  .object({ probe: z.boolean().optional() })
  .strict();

export const computerUseHelperPermissionRequestParamsSchema = z
  .object({
    kind: computerUseHelperPermissionRequestKindSchema,
  })
  .strict();

export const computerUseHelperPermissionRequestResultSchema = z
  .object({
    requested: z.boolean(),
    granted: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .strict();

export const computerUseHelperPointSchema = z
  .object({ x: z.number(), y: z.number() })
  .strict();

export const computerUseHelperSizeSchema = z
  .object({ width: z.number().nonnegative(), height: z.number().nonnegative() })
  .strict();

export const computerUseHelperApplicationSchema = z
  .object({
    pid: z.number().int().positive(),
    name: z.string().min(1),
    bundleId: z.string().min(1).nullable(),
    path: z.string().min(1).nullable(),
    active: z.boolean(),
    hidden: z.boolean(),
  })
  .strict();

export const computerUseHelperWindowSchema = z
  .object({
    windowId: z.number().int().nonnegative(),
    pid: z.number().int().positive(),
    title: z.string(),
    layer: z.number().int(),
    onScreen: z.boolean(),
    bounds: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number().nonnegative(),
        height: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const computerUseHelperDisplaySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    bounds: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .strict(),
    scaleFactor: z.number().positive(),
    primary: z.boolean(),
  })
  .strict();

export const computerUseHelperDisplaysResultSchema = z
  .object({ displays: z.array(computerUseHelperDisplaySchema) })
  .strict();

export interface ComputerUseHelperAxNode {
  role: string;
  subrole?: string | undefined;
  title?: string | undefined;
  value?: string | undefined;
  description?: string | undefined;
  identifier?: string | undefined;
  enabled?: boolean | undefined;
  focused?: boolean | undefined;
  position?: { x: number; y: number } | undefined;
  size?: { width: number; height: number } | undefined;
  actions?: string[] | undefined;
  children?: ComputerUseHelperAxNode[] | undefined;
}

export const computerUseHelperAxNodeSchema: z.ZodType<ComputerUseHelperAxNode> =
  z.lazy(() =>
    z
      .object({
        role: z.string().min(1),
        subrole: z.string().optional(),
        title: z.string().optional(),
        value: z.string().optional(),
        description: z.string().optional(),
        identifier: z.string().optional(),
        enabled: z.boolean().optional(),
        focused: z.boolean().optional(),
        position: computerUseHelperPointSchema.optional(),
        size: computerUseHelperSizeSchema.optional(),
        actions: z.array(z.string()).optional(),
        children: z.array(computerUseHelperAxNodeSchema).optional(),
      })
      .strict(),
  );

export const computerUseHelperApplicationsResultSchema = z
  .object({ applications: z.array(computerUseHelperApplicationSchema) })
  .strict();

export const computerUseHelperWindowsParamsSchema = z
  .object({ pid: z.number().int().positive() })
  .strict();

export const computerUseHelperWindowsResultSchema = z
  .object({ windows: z.array(computerUseHelperWindowSchema) })
  .strict();

export const computerUseHelperAxTreeParamsSchema = z
  .object({
    pid: z.number().int().positive(),
    maxDepth: z.number().int().min(1).max(64).optional(),
    maxChildren: z.number().int().min(1).max(1000).optional(),
    maxNodes: z.number().int().min(1).max(10000).optional(),
    titleMaxChars: z.number().int().min(1).max(500).optional(),
    valueMaxChars: z.number().int().min(1).max(10000).optional(),
    maxActions: z.number().int().min(1).max(100).optional(),
    timeoutMs: z.number().int().min(100).max(10000).optional(),
  })
  .strict();

export const computerUseHelperAxTreeResultSchema = z
  .object({
    pid: z.number().int().positive(),
    root: computerUseHelperAxNodeSchema,
    nodeCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const computerUseHelperScreenshotParamsSchema = z
  .object({
    pid: z.number().int().positive(),
    windowId: z.number().int().nonnegative(),
    maxBytes: z
      .number()
      .int()
      .min(1_000)
      .max(50 * 1024 * 1024)
      .optional(),
    maxDimension: z.number().int().min(64).max(8192).optional(),
  })
  .strict();

export const computerUseHelperScreenshotResultSchema = z
  .object({
    pid: z.number().int().positive(),
    windowId: z.number().int().nonnegative(),
    frame: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number().nonnegative(),
        height: z.number().nonnegative(),
      })
      .strict(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    format: z.literal("png"),
    imageBase64: z.string().min(1),
    blackFrame: z.boolean(),
    capturedAt: z.string().min(1),
  })
  .strict();

const computerUseHelperPidSchema = z.number().int().positive();

export const computerUseHelperClickParamsSchema = z
  .object({
    pid: computerUseHelperPidSchema,
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right", "middle"]).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
  })
  .strict();

export const computerUseHelperTypeParamsSchema = z
  .object({
    pid: computerUseHelperPidSchema,
    text: z.string().min(1).max(100_000),
    delayMs: z.number().int().min(0).max(1_000).optional(),
  })
  .strict();

export const computerUseHelperKeyParamsSchema = z
  .object({
    pid: computerUseHelperPidSchema,
    key: z.string().min(1).max(32),
    modifiers: z
      .array(z.enum(["cmd", "shift", "option", "control"]))
      .max(4)
      .optional(),
    repeat: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export const computerUseHelperScrollParamsSchema = z
  .object({
    pid: computerUseHelperPidSchema,
    x: z.number().optional(),
    y: z.number().optional(),
    deltaX: z.number().min(-100_000).max(100_000),
    deltaY: z.number().min(-100_000).max(100_000),
    unit: z.enum(["pixel", "line"]).optional(),
  })
  .strict();

export const computerUseHelperDragParamsSchema = z
  .object({
    pid: computerUseHelperPidSchema,
    fromX: z.number(),
    fromY: z.number(),
    toX: z.number(),
    toY: z.number(),
    durationMs: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

export const computerUseHelperActionResultSchema = z
  .object({ performed: z.boolean() })
  .strict();

export const computerUseHelperClipboardReadResultSchema = z
  .object({ text: z.string() })
  .strict();

export const computerUseHelperClipboardWriteParamsSchema = z
  .object({ text: z.string().max(1_000_000) })
  .strict();

export const computerUseHelperClipboardWriteResultSchema = z
  .object({ written: z.boolean() })
  .strict();

export const computerUseHelperErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    actionSent: z.boolean().optional(),
  })
  .strict();

export const computerUseHelperRequestSchema = z
  .object({
    id: z.string().min(1),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

export const computerUseHelperResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      id: z.string().min(1),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      ok: z.literal(false),
      error: computerUseHelperErrorSchema,
    })
    .strict(),
]);

export type ComputerUseHelperPermissionState = z.infer<
  typeof computerUseHelperPermissionStateSchema
>;
export type ComputerUseHelperPermissionStatus = z.infer<
  typeof computerUseHelperPermissionStatusSchema
>;
export type ComputerUseHelperHelloParams = z.infer<
  typeof computerUseHelperHelloParamsSchema
>;
export type ComputerUseHelperHelloResult = z.infer<
  typeof computerUseHelperHelloResultSchema
>;
export type ComputerUseHelperPermissionRequestKind = z.infer<
  typeof computerUseHelperPermissionRequestKindSchema
>;
export type ComputerUseHelperPermissionStatusParams = z.infer<
  typeof computerUseHelperPermissionStatusParamsSchema
>;
export type ComputerUseHelperPermissionRequestParams = z.infer<
  typeof computerUseHelperPermissionRequestParamsSchema
>;
export type ComputerUseHelperPermissionRequestResult = z.infer<
  typeof computerUseHelperPermissionRequestResultSchema
>;
export type ComputerUseHelperApplication = z.infer<
  typeof computerUseHelperApplicationSchema
>;
export type ComputerUseHelperWindow = z.infer<
  typeof computerUseHelperWindowSchema
>;
export type ComputerUseHelperDisplay = z.infer<
  typeof computerUseHelperDisplaySchema
>;
export type ComputerUseHelperDisplaysResult = z.infer<
  typeof computerUseHelperDisplaysResultSchema
>;
export type ComputerUseHelperApplicationsResult = z.infer<
  typeof computerUseHelperApplicationsResultSchema
>;
export type ComputerUseHelperWindowsResult = z.infer<
  typeof computerUseHelperWindowsResultSchema
>;
export type ComputerUseHelperAxTreeParams = z.infer<
  typeof computerUseHelperAxTreeParamsSchema
>;
export type ComputerUseHelperAxTreeResult = z.infer<
  typeof computerUseHelperAxTreeResultSchema
>;
export type ComputerUseHelperScreenshotParams = z.infer<
  typeof computerUseHelperScreenshotParamsSchema
>;
export type ComputerUseHelperScreenshotResult = z.infer<
  typeof computerUseHelperScreenshotResultSchema
>;
export type ComputerUseHelperClickParams = z.infer<
  typeof computerUseHelperClickParamsSchema
>;
export type ComputerUseHelperTypeParams = z.infer<
  typeof computerUseHelperTypeParamsSchema
>;
export type ComputerUseHelperKeyParams = z.infer<
  typeof computerUseHelperKeyParamsSchema
>;
export type ComputerUseHelperScrollParams = z.infer<
  typeof computerUseHelperScrollParamsSchema
>;
export type ComputerUseHelperDragParams = z.infer<
  typeof computerUseHelperDragParamsSchema
>;
export type ComputerUseHelperActionResult = z.infer<
  typeof computerUseHelperActionResultSchema
>;
export type ComputerUseHelperClipboardReadResult = z.infer<
  typeof computerUseHelperClipboardReadResultSchema
>;
export type ComputerUseHelperClipboardWriteParams = z.infer<
  typeof computerUseHelperClipboardWriteParamsSchema
>;
export type ComputerUseHelperClipboardWriteResult = z.infer<
  typeof computerUseHelperClipboardWriteResultSchema
>;
export type ComputerUseHelperError = z.infer<
  typeof computerUseHelperErrorSchema
>;
export type ComputerUseHelperRequest = z.infer<
  typeof computerUseHelperRequestSchema
>;
export type ComputerUseHelperResponse = z.infer<
  typeof computerUseHelperResponseSchema
>;

/** 逐行协议：空白行和坏 JSON 返回 null，由调用方返回可读错误。 */
export function parseComputerUseHelperRequestLine(
  line: string,
): ComputerUseHelperRequest | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = computerUseHelperRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function serializeComputerUseHelperResponse(
  response: ComputerUseHelperResponse,
): string {
  return `${JSON.stringify(response)}\n`;
}
