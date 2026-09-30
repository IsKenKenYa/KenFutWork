/**
 * zcode 照搬：`@/chat-input-toolbar/codingPlanQuotaResetAutoPlay.ts`（references/zcode/packages/ui/src/chat-input-toolbar/codingPlanQuotaResetAutoPlay.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */
import type {
  CodingPlanQuotaResetAutoPlayReservation,
  CodingPlanQuotaResetAutoPlayReservationAttempt,
} from "@zui/store/codingPlanQuotaResetState";

type CodingPlanQuotaResetAutoPlayCoordinationResult =
  | { status: "committed" }
  | { status: "released" }
  | { status: "retry"; retryAfterMs: number }
  | { status: "blocked" };

/**
 * 把异步 reservation 和组件展示边界串起来。
 *
 * Main 返回 winner 时 Composer 可能已经卸载或切换 source；必须先用 isCurrent
 * 复核，再 commit played。失效 winner 只 release token，不能消费全局播放资格。
 */
export async function coordinateCodingPlanQuotaResetAutoPlay(params: {
  reserve: () => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  isCurrent: () => boolean;
  commit: (reservation: CodingPlanQuotaResetAutoPlayReservation) => boolean;
  release: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;
  onCommitted: (reservation: CodingPlanQuotaResetAutoPlayReservation) => void;
}): Promise<CodingPlanQuotaResetAutoPlayCoordinationResult> {
  const attempt = await params.reserve();
  if (attempt.status === "retry") {
    return attempt;
  }
  if (attempt.status === "blocked") {
    return attempt;
  }

  const { reservation } = attempt;
  if (!params.isCurrent()) {
    await params.release(reservation);
    return { status: "released" };
  }
  if (!params.commit(reservation)) {
    await params.release(reservation);
    return { status: "released" };
  }

  params.onCommitted(reservation);
  return { status: "committed" };
}
