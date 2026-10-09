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
const CHAT_SIDEBAR = readFileSync(
  join(COMPONENTS, "chat-sidebar.tsx"),
  "utf-8",
);
const DESIGN_HOME = readFileSync(
  join(COMPONENTS, "workbench", "canvas-workbench", "design-home.tsx"),
  "utf-8",
);
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
    expect(CHAT_INPUT).toMatch(
      /onTranscript:\s*\(text\)\s*=>\s*\{\s*setValue\(/,
    );
    expect(WORKBENCH).toContain("CodeWorkbenchFrame");
    expect(WORKBENCH).not.toContain("useComposerVoice({");
  });

  it("播报接线：run 收尾念回复 + 开始说话即打断（Design 画布助手）", () => {
    // 收尾播报：读缓存里的完整正文 → 只念该念的 → 共享播报实例
    expect(CHAT_SIDEBAR).toContain("readSessionMessages(currentSessionId)");
    expect(CHAT_SIDEBAR).toContain("extractSpeakableText(text)");
    expect(CHAT_SIDEBAR).toContain("getVoicePlayback()");
    expect(CHAT_SIDEBAR).toContain(
      'voice.mode === "loop" && voice.speakReplies',
    );
    // 打断三触点：发送即停、录音起手即停、换画布/卸载即停
    expect(CHAT_SIDEBAR).toContain("getVoicePlayback().stop();");
    expect(CHAT_INPUT).toContain(
      "onRecordingStart: () => getVoicePlayback().stop()",
    );
    expect(DESIGN_HOME).toContain(
      "onRecordingStart: () => getVoicePlayback().stop()",
    );
  });

  it("中指代消解：会话上下文喂进「想」段（Design 侧）", () => {
    expect(CHAT_SIDEBAR).toContain("buildRefineContext(");
    expect(CHAT_SIDEBAR).toContain("recentMessages={voiceRecentMessages}");
    expect(CHAT_INPUT).toContain("recentMessages");
  });

  it("Design 空态输入框也接上语音（手势 / 状态行 / 受控写回 / 完整回路同一条提交路径）", () => {
    expect(DESIGN_HOME).toContain("useComposerVoice({");
    expect(DESIGN_HOME).toContain("onPointerDown={voice.onPointerDown}");
    expect(DESIGN_HOME).toContain("{voice.status}");
    expect(DESIGN_HOME).toMatch(
      /onTranscript:\s*\(text\)\s*=>\s*\n?\s*setPrompt\(/,
    );
    // 完整回路：与发送键同一条路径（展开命令后交给 onSubmit 起会话），不另起通道
    expect(DESIGN_HOME).toMatch(/onAutoSubmit:\s*\(text\)\s*=>/);
    expect(DESIGN_HOME).toContain("startTask(expanded);");
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

  it("Code 侧播报与指代消解接线（回复完成才念 + 上下文喂进改写）", () => {
    // 回复**从 streaming 转为 complete** 才念（历史行不重念）
    expect(CODE_COMPOSER).toContain("recentMessagesFromSnapshot(snapshot)");
    expect(CODE_COMPOSER).toContain("voiceRef.current?.speakReply(last.text)");
    expect(CODE_COMPOSER).toContain('last.state === "complete"');
    // 「想」段上下文喂到桥里
    expect(CODE_COMPOSER).toContain("recentMessages: voiceRecentMessages");
    expect(CODE_VOICE_BINDING).toContain("speakReply");
    expect(CODE_VOICE_BINDING).toContain("onRecordingStart: stopSpeaking");
    // 播报通道：宿主 transport → iframe HTTP 通道的二进制请求
    expect(CODE_HOST_MAIN).toContain(
      "speak: (input) => client.speakVoice(input)",
    );
    expect(CODE_HTTP_CLIENT).toContain("async speakVoice(");
  });
});
