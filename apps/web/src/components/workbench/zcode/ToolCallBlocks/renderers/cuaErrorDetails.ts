/**
 * zcode 照搬：`@/ToolCallBlocks/renderers/cuaErrorDetails.ts`（references/zcode/packages/ui/src/ToolCallBlocks/renderers/cuaErrorDetails.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
import type { ToolCallBlockRenderContext } from "@zui/ToolCallBlocks/shared";

interface CuaErrorDetails {
  code: string;
  stateId: string | null;
  elementIndex: number | null;
  targetAppName: string | null;
  targetBundleId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readCuaErrorDetails(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): CuaErrorDetails | null {
  const raw = asRecord(toolCall.raw);
  const output =
    typeof toolCall.output === "string"
      ? toolCall.output
      : typeof raw?.rawOutput === "string"
        ? raw.rawOutput
        : "";
  const marker = "Error executing tool";
  const markerIndex = output.indexOf(marker);
  const jsonStart = markerIndex >= 0 ? output.indexOf("{", markerIndex) : -1;
  if (jsonStart < 0) return null;
  try {
    const error = asRecord(JSON.parse(output.slice(jsonStart)));
    const code = readText(error, "error");
    if (!code) return null;
    const targetApp = asRecord(error?.target_app);
    return {
      code,
      stateId: readText(error, "state_id"),
      elementIndex: typeof error?.index === "number" ? error.index : null,
      targetAppName: readText(targetApp, "name"),
      targetBundleId: readText(targetApp, "bundle_id"),
    };
  } catch {
    return null;
  }
}
