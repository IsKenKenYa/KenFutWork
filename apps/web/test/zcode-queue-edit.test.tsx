import { fireEvent, render, screen } from "@testing-library/react";
import { queueStateSchema } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { ConversationQueuePanel } from "@zui/v4/ConversationQueuePanel.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  queueComposerEditScope,
  readV4ComposerDraft,
} from "@zui/v4/composer/composerDraftStore.js";
import { describe, expect, it } from "vitest";

describe("排队消息编辑", () => {
  it("编辑草稿只驻留在自己的窗口内存，取消后原 Task 草稿完整保留", () => {
    const workspace = "/queue-edit-test";
    const taskId = "task-1";
    const scope = queueComposerEditScope("edit-1");
    try {
      persistV4ComposerDraft(workspace, undefined, taskId, {
        text: "原有草稿",
        mode: "build",
      });
      persistV4ComposerDraft(workspace, undefined, scope, {
        text: "正在编辑的文字",
        mode: "plan",
      });
      expect(readV4ComposerDraft(workspace, undefined, scope)).toMatchObject({
        text: "正在编辑的文字",
        mode: "plan",
      });
      const saved = localStorage.getItem(
        `zcode-v4-composer-drafts:v1:${encodeURIComponent(workspace)}`,
      );
      expect(saved).toContain("原有草稿");
      expect(saved).not.toContain("正在编辑的文字");
      clearV4ComposerDraft(workspace, undefined, scope);
      expect(readV4ComposerDraft(workspace, undefined, scope)).toBeNull();
      expect(readV4ComposerDraft(workspace, undefined, taskId)).toMatchObject({
        text: "原有草稿",
        mode: "build",
      });
    } finally {
      clearV4ComposerDraft(workspace, undefined, scope);
      clearV4ComposerDraft(workspace, undefined, taskId);
    }
  });

  it("其他窗口的锁只能按看到的编辑身份解除，不能立即发送或删除", () => {
    const editorId = "1a5e4d90-754b-4df1-a546-18ee072886c5";
    const queue = queueStateSchema.parse({
      autoDrain: true,
      items: [
        {
          queueItemId: "queue-item",
          clientId: "client",
          sourceCommandId: "source",
          text: "等待编辑",
          kind: "sendText",
          attachments: [],
          admittedAt: 1,
          delivery: { requested: "auto", admitted: "queue" },
          order: { admissionSeq: 1, queuePosition: 0 },
          steer: { state: "notRequested" },
          dispatch: { state: "queued" },
          editLock: { editorId, clientId: "client" },
        },
      ],
    });
    const releases: string[][] = [];
    render(
      <ZCodeIntlProvider initialLocale="zh-CN">
        <TooltipProvider>
          <ConversationQueuePanel
            queue={queue}
            onSendNow={() => {
              throw new Error("锁定时不能派发");
            }}
            onDeleteItem={() => {
              throw new Error("锁定时不能删除");
            }}
            onReleaseEdit={(item, edit) => releases.push([item, edit])}
          />
        </TooltipProvider>
      </ZCodeIntlProvider>,
    );
    screen.getByText("其他窗口正在编辑");
    expect(screen.queryByRole("button", { name: "立即" })).toBeNull();
    expect(screen.queryByRole("button", { name: "移除待发送消息" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "解除编辑" }));
    expect(releases).toEqual([["queue-item", editorId]]);
  });
});

import { TooltipProvider } from "@zui/components/ui/tooltip.js";
