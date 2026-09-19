import { describe, expect, it } from "vitest";

import {
  checkpointDiffResponseSchema,
  checkpointListQuerySchema,
  checkpointListResponseSchema,
  checkpointPreviewResponseSchema,
  checkpointRestoreResponseSchema,
  checkpointSummarySchema,
} from "./checkpoints.js";

/**
 * 检查点契约（影子 git）：解析与拒绝口径。
 * 重点锁：40 位十六进制 sha、二进制行数 null、未知 kind 拒绝、zod 剥离多余键
 * （服务行带 workspaceId/canvasId，API 面不带）。
 */

const sha1 = "a".repeat(40);
const sha2 = "b".repeat(40);

const summary = {
  id: "ck-1",
  runId: null,
  kind: "turn",
  label: "轮次开始快照",
  shadowCommit: sha1,
  filesChanged: 2,
  insertions: 3,
  deletions: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("checkpointSummarySchema", () => {
  it("解析合法摘要；额外键被剥离（服务行不外发工作区/画布 id）", () => {
    const parsed = checkpointSummarySchema.parse({
      ...summary,
      workspaceId: "ws-1",
      canvasId: "canvas-1",
    });
    expect(parsed).toEqual(summary);
    expect(parsed).not.toHaveProperty("workspaceId");
  });

  it("拒绝非 40 位十六进制的 shadowCommit 与未知 kind", () => {
    expect(
      checkpointSummarySchema.safeParse({
        ...summary,
        shadowCommit: "短 sha",
      }).success,
    ).toBe(false);
    expect(
      checkpointSummarySchema.safeParse({
        ...summary,
        shadowCommit: "A".repeat(40),
      }).success,
    ).toBe(false);
    expect(
      checkpointSummarySchema.safeParse({ ...summary, kind: "snapshot" })
        .success,
    ).toBe(false);
  });

  it("runId 允许 null（回滚恢复点无 run）", () => {
    expect(
      checkpointSummarySchema.safeParse({ ...summary, runId: "run-1" }).success,
    ).toBe(true);
    expect(
      checkpointSummarySchema.safeParse({ ...summary, runId: null }).success,
    ).toBe(true);
  });
});

describe("checkpointListResponseSchema / query", () => {
  it("列表解析收下；query 缺 canvasId 拒绝", () => {
    expect(
      checkpointListResponseSchema.parse({ checkpoints: [summary] }),
    ).toEqual({ checkpoints: [summary] });
    expect(checkpointListQuerySchema.safeParse({}).success).toBe(false);
    expect(checkpointListQuerySchema.parse({ canvasId: "canvas-1" })).toEqual({
      canvasId: "canvas-1",
    });
  });
});

describe("checkpointDiffResponseSchema", () => {
  it("diff 文本 + 逐文件增删；二进制文件行数为 null 而不是 0", () => {
    const parsed = checkpointDiffResponseSchema.parse({
      diff: "diff --git a/a.txt b/a.txt\n",
      files: [
        { path: "a.txt", added: 1, deleted: 0 },
        { path: "logo.png", added: null, deleted: null },
      ],
    });
    expect(parsed.files[1]).toEqual({
      path: "logo.png",
      added: null,
      deleted: null,
    });
    expect(
      checkpointDiffResponseSchema.safeParse({
        diff: "",
        files: [{ path: "a.txt", added: 0, deleted: 0 }],
      }).success,
    ).toBe(true);
    // 伪造二进制行数（非 null 数字以外的形态）仍按 schema 校验
    expect(
      checkpointDiffResponseSchema.safeParse({
        diff: "",
        files: [{ path: "a.txt", added: "many", deleted: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe("checkpointPreviewResponseSchema", () => {
  it("targetSha + 受影响清单与汇总；targetSha 非法拒绝", () => {
    const preview = {
      targetSha: sha2,
      files: [{ path: "a.txt", added: 2, deleted: 1 }],
      filesChanged: 1,
      insertions: 2,
      deletions: 1,
    };
    expect(checkpointPreviewResponseSchema.parse(preview)).toEqual(preview);
    expect(
      checkpointPreviewResponseSchema.safeParse({ ...preview, targetSha: "x" })
        .success,
    ).toBe(false);
  });
});

describe("checkpointRestoreResponseSchema", () => {
  it("回滚结果含恢复后的当前状态摘要", () => {
    expect(
      checkpointRestoreResponseSchema.parse({ checkpoint: summary }),
    ).toEqual({ checkpoint: summary });
  });
});
