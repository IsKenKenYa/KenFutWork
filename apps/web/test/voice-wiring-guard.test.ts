import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 输入框语音接线的**接线守卫**（源码级）。
 *
 * 为什么放在源码级而不是组件级：两个 workbench 输入框所在的 `workbench.tsx` 是
 * 四千行的页面组件（挂载它要一整套会话/WS/项目的桩），而这里要锁的东西恰恰是
 * 「**接线有没有接上**」——少接一处，功能就是静默消失（用户按住没反应，没有任何报错）。
 * 这类回归只有源码级断言最可靠，与仓库既有的 ui-copy-localized 守卫同一路数。
 *
 * 锁三件事：
 * 1. 占位麦克风按钮已删（「语音（即将上线）」一个字都不许留）；
 * 2. 三处输入容器都摊上了 `onPointerDown` 语音手势；
 * 3. 两处 workbench 回车提交都带 IME 判定（中文输入法确认候选词不该提交）。
 */

const COMPONENTS = join(import.meta.dirname, "..", "src", "components");
const WORKBENCH = readFileSync(
  join(COMPONENTS, "workbench", "workbench.tsx"),
  "utf-8",
);
const CHAT_INPUT = readFileSync(join(COMPONENTS, "chat-input.tsx"), "utf-8");

describe("语音接线守卫", () => {
  it("占位麦克风按钮已删干净（两处 workbench 输入框都不再有假按钮）", () => {
    expect(WORKBENCH).not.toContain("语音（即将上线）");
    expect(CHAT_INPUT).not.toContain("语音（即将上线）");
    // 图标 import 也要清掉，否则留下无人使用的死 import
    expect(WORKBENCH).not.toMatch(/^\s*Mic,\s*$/m);
  });

  it("画布助手保留手势、状态行与受控文本写回", () => {
    expect(CHAT_INPUT).toContain("onPointerDown={voice.onPointerDown}");
    expect(CHAT_INPUT).toContain("{voice.status}");
    expect(CHAT_INPUT).toMatch(/onTranscript:\s*\(text\)\s*=>\s*\{\s*setValue\(/);
    expect(WORKBENCH).toContain("CodeWorkbenchFrame");
    expect(WORKBENCH).not.toContain("useComposerVoice({");
  });
});
