import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { codeUiEventSchema } from "./code-ui-contracts.js";

it("SSE文档通知复用WS索引契约，不带Run/Task/正文或凭据", () => {
  const data = {
    type: "canvas.document.updated",
    canvasId: randomUUID(),
    projectId: randomUUID(),
    revision: "a".repeat(64),
    deleted: false,
  };
  expect(
    codeUiEventSchema.parse({
      event: "canvasDocumentUpdated",
      data: {
        ...data,
        runId: "fake",
        content: "private",
        accessToken: "secret",
      },
    }),
  ).toEqual({ event: "canvasDocumentUpdated", data });
  expect(
    codeUiEventSchema.safeParse({
      event: "canvasDocumentUpdated",
      data: { ...data, revision: "invalid" },
    }).success,
  ).toBe(false);
  expect(
    codeUiEventSchema.parse({
      event: "canvasDocumentUpdated",
      data: {
        type: data.type,
        canvasId: data.canvasId,
        projectId: data.projectId,
        deleted: true,
      },
    }),
  ).toEqual({
    event: "canvasDocumentUpdated",
    data: {
      type: data.type,
      canvasId: data.canvasId,
      projectId: data.projectId,
      deleted: true,
    },
  });
});
