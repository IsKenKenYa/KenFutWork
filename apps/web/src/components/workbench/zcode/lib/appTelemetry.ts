/**
 * zcode 照搬：`@/lib/appTelemetry.ts`（references/zcode/packages/ui/src/lib/appTelemetry.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  type BuiltinModelProviderId,
  collectTelemetryRendererContext,
  type IPlatformService,
  isZaiCodingPlanProviderId,
  sanitizeTelemetryEventDetail,
  ZAI_PROVIDER_ID,
} from "@zui/lib/zcode-shared";
import { logger } from "@zui/logger";

export function resolveProviderTelemetryLabel(providerId: string): string {
  if (providerId === ZAI_PROVIDER_ID || isZaiCodingPlanProviderId(providerId)) {
    return "z.ai";
  }

  if (
    providerId === BIGMODEL_PROVIDER_ID ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  ) {
    return "bigmodel";
  }

  return providerId;
}

export function resolvePresetModelProviderTelemetryLabel(
  presetId: BuiltinModelProviderId,
): string {
  return resolveProviderTelemetryLabel(presetId);
}

/**
 * 适配注记（P9）：宿主 platform 切片（hooks/usePlatform 禁改件）未声明 reportTelemetryEvent
 * （zcode IPlatformService 必有）；消费侧按可选能力降级——缺席时静默跳过上报。
 */
type ReportTelemetryPlatform = {
  reportTelemetryEvent?: IPlatformService["reportTelemetryEvent"] | undefined;
};

export async function reportAppTelemetryEvent(
  platform: ReportTelemetryPlatform,
  payload: {
    elementName: string;
    eventRegion: string;
    eventType: string;
    eventText?: string;
    eventExtraDetail: Record<string, string>;
    userId?: string;
    talkId?: string;
    messageId?: string;
  },
  scope: string,
): Promise<void> {
  try {
    const reportPayload = {
      context: collectTelemetryRendererContext(),
      ...payload,
      eventExtraDetail: sanitizeTelemetryEventDetail(
        payload.elementName,
        payload.eventExtraDetail,
      ),
    };

    // 修复原因：只在 Core 清洗会让原文先经过 IPC/本地日志；此处只记录清洗后的副本。
    // step 与消息同量级，调试输出使用 debug，不产生 info 落盘副本。
    if (
      payload.elementName === "message_completion" ||
      payload.elementName === "agent_step"
    ) {
      logger.debug(`[${scope}] ${payload.elementName} payload:`, reportPayload);
    }

    await platform.reportTelemetryEvent?.(reportPayload);
  } catch {
    // 最终失败由 Desktop Main 的 TelemetryCore 统一记录脱敏告警；UI 只维持业务隔离，
    // 避免同一失败重复记录，或把 IPC 原始错误带入生产日志。
  }
}
