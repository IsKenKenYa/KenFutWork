import { describe, expect, it } from "vitest";
import { projectSummarySchema } from "./contracts.js";

describe("Code 项目工作域契约", () => {
  it("Code 项目使用真实目录且不含画布，Design 项目仍要求主画布", () => {
    const project = {
      id: "c15b75a5-b7ef-46b5-8b0c-d543dd7769d5",
      name: "应用",
      slug: "app",
      description: null,
      workspace: {
        id: "2cdb5c27-a1f7-4109-9927-40e0b0822956",
        name: "工作区",
        type: "personal",
        ownerUserId: "7b4b2269-87bd-45ec-930d-ec134f506f39",
      },
      createdAt: "2026-10-03T08:00:00.000Z",
      updatedAt: "2026-10-03T08:00:00.000Z",
    };
    const code = projectSummarySchema.parse({
      ...project,
      kind: "code",
      workDir: "/home/user/app",
      additionalDirectories: [{ path: "/home/user/reference", access: "read-only" }],
    });
    expect(code).not.toHaveProperty("primaryCanvas");
    expect(code.workDir).toBe("/home/user/app");
    expect(projectSummarySchema.safeParse({ ...project, kind: "design" }).success).toBe(false);
  });
});
