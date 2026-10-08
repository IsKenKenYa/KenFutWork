import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 输入框语音接线的**接线守卫**（源码级）。
 *
 * 为什么放在源码级而不是组件级：画布助手挂在 workbench 页面（挂载要一整套会话/WS/
 * 项目的桩），ZCode composer 是 vendored 大组件，而这里要锁的东西恰恰是
 * 「**接线有没有接上**」——少接一处，功能就是静默消失（用户按住没反应，没有任何报错）。
 * 这类回归只有源码级断言最可靠，与仓库既有的 ui-copy-localized 守卫同一路数。
 *
 * 锁三件事（Code 界面整合后的现状——旧 workbench 输入框已随整合退役）：
 * 1. 占位麦克风按钮已删（「语音（即将上线）」一个字都不许留，图标 import 同步清）；
 * 2. 画布助手（Design）保留手势、状态行与受控文本写回，且 workbench 壳不再自接语音；
 * 3. Code 模式入口在 ZCode composer 一侧：三触点（手势/状态行/appendText 写回）+
 *    宿主桥注入 transport（适配登记见《ZCode源码清单》与阶段同步记录）。
 */

const COMPONENTS = join(import.meta.dirname, "..", "src", "components");
const WORKBENCH = readFileSync(
  join(COMPONENTS, "workbench", "workbench.tsx"),
  "utf-8",
);
const CHAT_INPUT = readFileSync(join(COMPONENTS, "chat-input.tsx"), "utf-8");
const ZCODE = join(COMPONENTS, "workbench", "zcode");
const CODE_COMPOSER = readFileSync(
  join(ZCODE, "v4", "ConversationComposer.tsx"),
  "utf-8",
);
const CODE_VOICE_BINDING = readFileSync(
  join(ZCODE, "voice", "binding.tsx"),
  "utf-8",
);
const CODE_HOST_MAIN = readFileSync(join(ZCODE, "host", "main.tsx"), "utf-8");
const CODE_HTTP_CLIENT = readFileSync(
  join(ZCODE, "host", "httpChannelClient.ts"),
  "utf-8",
);

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

  it("Code 输入框接上语音桥（composer 三触点 + 宿主注入 transport）", () => {
    // 三触点：手势摊在输入卡上、状态行渲染、写回走 appendText
    expect(CODE_COMPOSER).toContain(
      'import { useCodeComposerVoice } from "@zui/voice/binding.js";',
    );
    expect(CODE_COMPOSER).toContain("useCodeComposerVoice({");
    expect(CODE_COMPOSER).toContain("onPointerDown={voice?.onPointerDown}");
    expect(CODE_COMPOSER).toContain("{voice?.status}");
    expect(CODE_COMPOSER).toContain("inputApiRef.current?.appendText(");
    // 完整回路：写回后走 composer 自己的提交路径（不是另起一条发送通道）；
    // 且必须等 appendText 回传草稿后再提交——立即 submit 会读到旧文本而空转
    //（真机验收抓到的缺陷：文本留在草稿里但不执行）
    expect(CODE_COMPOSER).toContain("voiceAutoSubmitRef.current = prompt;");
    expect(CODE_COMPOSER).toContain("text.includes(pending)");
    expect(CODE_COMPOSER).toContain("void submit();");
    // 宿主桥：Provider + 核心编排复用 + multipart 转写通道
    expect(CODE_VOICE_BINDING).toContain("CodeVoiceProvider");
    expect(CODE_VOICE_BINDING).toContain("useComposerVoice({");
    expect(CODE_HOST_MAIN).toContain("CodeVoiceProvider");
    expect(CODE_HOST_MAIN).toContain(
      "transcribe: (wav) => client.transcribeVoice(wav)",
    );
    expect(CODE_HTTP_CLIENT).toContain("async transcribeVoice(");
  });
});
