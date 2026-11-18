import { startTaskDraft } from "@zui/root/useRootWorkspaceActions.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@zui/v4/composer/composerDraftStore.js";
import { beforeEach, expect, it } from "vitest";

beforeEach(() => {
  localStorage.clear();
});

it("新任务草稿的 executionMode 能跨读写保留", () => {
  persistV4ComposerDraft("/ws", undefined, V4_DRAFT_SCOPE_ROOT, {
    text: "创建一个技能：\n",
    executionMode: "creative",
  });
  const draft = readV4ComposerDraft("/ws", undefined, V4_DRAFT_SCOPE_ROOT);
  expect(draft?.text).toBe("创建一个技能：\n");
  expect(draft?.executionMode).toBe("creative");
});

it("只有 executionMode 没有正文的草稿不会被当成空草稿删除", () => {
  persistV4ComposerDraft("/ws", undefined, V4_DRAFT_SCOPE_ROOT, {
    text: "   ",
    executionMode: "creative",
  });
  expect(
    readV4ComposerDraft("/ws", undefined, V4_DRAFT_SCOPE_ROOT)?.executionMode,
  ).toBe("creative");
});

it("设置页创建入口把 executionMode 写进新任务草稿", () => {
  startTaskDraft(
    "settings-skill",
    { workspacePath: "/ws", workspaceIdentity: null },
    {
      initialPrompt: "创建一个技能：\n",
      executionMode: "creative",
    },
  );
  const draft = readV4ComposerDraft("/ws", undefined, V4_DRAFT_SCOPE_ROOT);
  expect(draft).toMatchObject({
    text: "创建一个技能：\n",
    executionMode: "creative",
  });
});

it("非法的 executionMode 被丢弃而不是污染草稿", () => {
  persistV4ComposerDraft("/ws", undefined, V4_DRAFT_SCOPE_ROOT, {
    text: "创建一个插件：\n",
    // 模拟历史/手写存储中的脏值
    executionMode: "unknown" as never,
  });
  const draft = readV4ComposerDraft("/ws", undefined, V4_DRAFT_SCOPE_ROOT);
  expect(draft?.text).toBe("创建一个插件：\n");
  expect(draft?.executionMode).toBeUndefined();
  clearV4ComposerDraft("/ws", undefined, V4_DRAFT_SCOPE_ROOT);
});
