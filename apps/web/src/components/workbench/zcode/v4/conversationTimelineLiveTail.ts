/**
 * zcode 照搬：`@/v4/conversationTimelineLiveTail.ts`（references/zcode/packages/ui/src/v4/conversationTimelineLiveTail.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
import type { ConversationTurnRenderUnit } from "@zui/v4/conversationTurnRenderUnits";

interface ConversationTimelineLiveTailSplit {
  virtualizedUnits: readonly ConversationTurnRenderUnit[];
  liveUnit: ConversationTurnRenderUnit | null;
  liveUnitIndex: number | null;
}

/**
 * running turn 继续放在绝对定位虚拟行里时，正文 DOM 会先长高，
 * ResizeObserver 下一帧才回填 totalSize/scrollTop，导致轮尾 ChatLoading 来回跳。
 * 只把真正的最后一个 running unit 拆成 normal-flow live tail；历史或陈旧 running
 * 行仍归虚拟列表，避免扩大常驻 DOM。
 */
export function splitConversationTimelineLiveTail(
  units: readonly ConversationTurnRenderUnit[],
): ConversationTimelineLiveTailSplit {
  const liveUnitIndex = units.length - 1;
  const liveUnit = units[liveUnitIndex];
  if (!liveUnit?.isRunning) {
    return { virtualizedUnits: units, liveUnit: null, liveUnitIndex: null };
  }
  return {
    virtualizedUnits: units.slice(0, liveUnitIndex),
    liveUnit,
    liveUnitIndex,
  };
}
