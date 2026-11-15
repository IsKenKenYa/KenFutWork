import { z } from "zod";
import { redactSecrets } from "../../utils/error-sanitizer.js";
import {
  createGenerationFetch,
  GenerationError,
  redactGenerationMessage,
} from "../utils.js";

const publicCodes: ReadonlyMap<string, string> = new Map([
  [
    "InputAudioSensitiveContentDetected.PolicyViolation",
    "media_input_audio_copyright",
  ],
  [
    "OutputAudioSensitiveContentDetected.PolicyViolation",
    "media_output_audio_copyright",
  ],
  ["InvalidParameter.TaskTypeConstraint", "media_task_type_constraint"],
  ["InvalidParameter.TaskTypeMismatch", "media_task_type_mismatch"],
]);

const rejectedTaskSchema = z.object({
  status: z.enum(["failed", "expired", "cancelled", "canceled"]),
  error: z
    .object({ code: z.string().nullish(), message: z.string().nullish() })
    .nullish(),
});

function providerFailure(
  code: string,
  detail: string,
  upstreamCode: string | undefined,
  status?: number,
) {
  const message = redactSecrets(
    upstreamCode ? `[${upstreamCode}] ${detail}` : detail,
  );
  return new GenerationError("volces", code, message, { upstreamCode, status });
}

/** SDK 会把 HTTP 200 的任务失败折叠成字符串，先在协议边界保留结构码。 */
export function createVolcesVideoFetch(
  sensitiveValues: readonly string[],
  polling: boolean,
): typeof fetch {
  const send = createGenerationFetch("volces", sensitiveValues);
  const redact = (value: string) =>
    redactGenerationMessage(value, sensitiveValues);
  return async (input, init) => {
    const response = await send(input, init).catch((error: unknown) => {
      if (
        error instanceof GenerationError &&
        error.upstreamCode &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500
      ) {
        const code = publicCodes.get(error.upstreamCode);
        if (code)
          throw providerFailure(
            code,
            error.message,
            error.upstreamCode,
            error.status,
          );
      }
      throw error;
    });
    if (!polling) return response;

    // 其余响应由 SDK 读取原始流并继续正常校验。
    const task = rejectedTaskSchema.safeParse(
      await response
        .clone()
        .json()
        .catch(() => undefined),
    );
    if (!task.success) return response;
    const { error, status } = task.data;
    const upstreamCode = error?.code ? redact(error.code) : undefined;
    const code =
      (upstreamCode && publicCodes.get(upstreamCode)) || "provider_task_failed";
    throw providerFailure(
      code,
      error?.message ? redact(error.message) : `供应商任务状态：${status}`,
      upstreamCode,
    );
  };
}
