/**
 * zcode 照搬：`@zcode/shared` zcode-protocol-v4/cuaPermission.ts（references/zcode/packages/shared/src/zcode-protocol-v4/cuaPermission.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
import { z } from "zod";
import type { CuaPermissionKind } from "../../zcode-shared";
import { timestampSchema } from "./core";

export const cuaRequestAccessStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    platform: z.literal("darwin"),
    grantOwner: z.string().min(1),
    accessibility: z.enum(["granted", "stale", "denied"]),
    screenRecording: z.enum(["granted", "denied", "unknown"]),
  })
  .strict();
export type CuaRequestAccessStatus = z.infer<
  typeof cuaRequestAccessStatusSchema
>;

export function requiredCuaPermissionsForRequestAccessStatus(
  status: CuaRequestAccessStatus,
): CuaPermissionKind[] {
  const required: CuaPermissionKind[] = [];
  if (status.accessibility === "denied" || status.accessibility === "stale") {
    required.push("accessibility");
  }
  if (status.screenRecording === "denied") {
    required.push("screen_recording");
  }
  return required;
}

export const cuaPermissionObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().min(1),
    eventSeq: z.number().int().nonnegative(),
    occurredAt: timestampSchema,
    sessionId: z.string().min(1),
    turnId: z.string().min(1).optional(),
    toolCallId: z.string().min(1),
    permissionStatus: cuaRequestAccessStatusSchema,
  })
  .strict();
export type CuaPermissionObservation = z.infer<
  typeof cuaPermissionObservationSchema
>;
