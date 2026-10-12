import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolMessage } from "@langchain/core/messages";
import sharp from "sharp";
import { expect, it } from "vitest";
import { kernelToolResultParts } from "../../agent/kernel-tools-bridge.js";
import { projectCanonicalToolEvent } from "../../agent/stream-adapter.js";
import { createCodeUiConversation } from "../code-ui/conversation.js";
import { goalEvidence, goalEvidenceCandidates } from "../code-ui/goals.js";
import { publicToolOutput } from "../code-ui/tool-lifecycle.js";
import type { ScopedFilesystemScope } from "../execution/scoped-filesystem.js";
import { createGoalService } from "../goals/service.js";
import { readMedia } from "./file-media.js";

async function readImageFixture(root: string) {
  const path = join(root, "quadrants.png");
  const bytes = await sharp(
    Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]),
    {
      raw: { width: 2, height: 2, channels: 3 },
    },
  )
    .png()
    .toBuffer();
  await writeFile(path, bytes);
  const scope: ScopedFilesystemScope = {
    role: "main",
    agentId: "main",
    describe: () => ({
      instanceId: "instance",
      projectId: "project",
      taskId: "task",
      generation: 1,
      rootDirectory: root,
      additionalDirectories: [],
      sandboxMode: "workspace-write",
    }),
    resolvePath: async (input, operation) => {
      if (operation !== "read" || input !== path) throw new Error("未授权路径");
      return realpath(input);
    },
  };
  const media = await readMedia(
    scope,
    {
      codeReadMaxBytes: 4096,
      codeReadPageCharacters: 4096,
      codeSearchMaxResults: 10,
      codeSearchMaxBytes: 4096,
      codePatchMaxBytes: 4096,
      codePdfMaxPages: 2,
      codePdfRenderScale: 1,
    },
    { path, capabilities: { image: true, pdf: false } },
  );
  const info = await stat(path);
  const expectedVersion = createHash("sha256")
    .update(
      `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
    )
    .update(createHash("sha256").update(bytes).digest())
    .digest("hex");
  const [content, artifact] = kernelToolResultParts(media);
  if (!Array.isArray(content)) throw new Error("图片缺少多模态内容");
  return { path, bytes, media, expectedVersion, content, artifact };
}

async function persistedReadFixture(
  root: string,
  path: string,
  content: ToolMessage["content"],
  artifact: { canonicalOutput: unknown },
) {
  const host = createCodeUiConversation({
    sessionId: "task",
    workspacePath: root,
    config: {
      provider: "zcode",
      model: "test",
      thought: "",
      followupMode: "queue",
    },
  });
  host.startTurn({ runId: "run", commandId: "send", text: "读取图片并验证" });
  const identity = {
    runId: "run",
    sessionId: "task",
    conversationId: "task",
  };
  for (const phase of ["started", "completed"]) {
    for await (const event of projectCanonicalToolEvent(
      {
        phase,
        toolName: "Read",
        toolCallId: "read-image",
        ...(phase === "started"
          ? { input: { file_path: path } }
          : {
              output: publicToolOutput(
                new ToolMessage({
                  content,
                  artifact,
                  name: "Read",
                  tool_call_id: "read-image",
                }),
              ),
            }),
      },
      identity,
    ))
      host.recordEvent(event);
  }
  const persisted = createCodeUiConversation({
    sessionId: "task",
    workspacePath: root,
    state: host.exportState(),
    config: host.getSnapshot().config,
  });
  const rows = persisted.getSnapshot().rows.window;
  const row = rows.find(
    (item) => item.kind === "toolCall" && item.toolName === "Read",
  );
  if (row?.kind !== "toolCall") throw new Error("真实Read缺少公开行");
  return { host, rows, row };
}

function claimedGoalFixture() {
  const goals = createGoalService();
  const goal = goals.claimRun(
    goals.create(null, {
      goalId: "goal",
      objective: "读取图片",
      branchGeneration: 1,
      at: 1,
    }),
    {
      goalId: "goal",
      revision: 1,
      runId: "run",
      at: 2,
      foreground: {
        branchGeneration: 1,
        taskReady: true,
        activeRunId: null,
        userReserved: false,
        userQueued: false,
        approvalWaiting: false,
      },
    },
  );
  return { goals, goal };
}

it("真实PNG读取事实沿多模态桥与持久公开行成为本Run Goal证据，保留原图片字节", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-image-goal-")));
  try {
    const { path, bytes, media, expectedVersion, content, artifact } =
      await readImageFixture(root);
    const image = content.find((block) => block.type === "image");
    expect(image).toEqual({
      type: "image",
      source_type: "base64",
      mime_type: "image/png",
      data: bytes.toString("base64"),
    });
    const text = content.find((block) => block.type === "text");
    expect(text?.text).toBe(
      JSON.stringify({
        type: "image",
        filePath: path,
        version: expectedVersion,
        mimeType: "image/png",
        width: 2,
        height: 2,
        sizeBytes: bytes.length,
      }),
    );
    expect(String(text?.text)).not.toContain(bytes.toString("base64"));
    expect(artifact.canonicalOutput).toEqual(media.canonicalOutput);
    expect(media.canonicalOutput).not.toHaveProperty("version");
    const { host, rows, row } = await persistedReadFixture(
      root,
      path,
      content,
      artifact,
    );
    expect(row.output?.text).toBe(text?.text);
    expect(goalEvidenceCandidates(rows, "run", 1)).toContainEqual({
      id: `row:${row.rowId}`,
      kind: "toolCall",
      revision: 1,
    });
    const evidence = goalEvidence(rows, "run", [`row:${row.rowId}`]);
    const { goals, goal } = claimedGoalFixture();
    expect(
      goals.verify(goal, {
        goalId: "goal",
        revision: goal.revision,
        runId: "run",
        evidence,
        verdict: { passed: true, reason: "真实图片读取事实与模型判断" },
        at: 3,
      }).status,
    ).toBe("complete");
    expect(goalEvidenceCandidates(rows, "other-run", 1)).toEqual([]);
    expect(() => goalEvidence(rows, "other-run", [`row:${row.rowId}`])).toThrow(
      "验收引用",
    );
    for (const altered of [
      { ...row, status: "error" as const },
      { ...row, output: { text: "" } },
    ])
      expect(goalEvidenceCandidates([altered], "run", 1)).toEqual([]);
    host.recordEvent({
      type: "message.delta",
      runId: "run",
      messageId: "answer",
      delta: "纯文本成果",
      timestamp: new Date().toISOString(),
    });
    expect(
      goalEvidenceCandidates(host.getSnapshot().rows.window, "run", 1).some(
        (item) => item.kind === "assistantText",
      ),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
