import { expect, it } from "vitest";
import { managedProviderPatchSchema } from "./model-management.js";

it("统一设置草稿必须携带读面修订，REST稀疏补丁不能绕开编辑CAS", () => {
  const providerId = "c0a03eb2-d58c-4637-9fda-c796230a751a";
  expect(
    managedProviderPatchSchema.safeParse({
      providerId,
      patch: { name: "迟到草稿" },
    }).success,
  ).toBe(false);
  expect(
    managedProviderPatchSchema.parse({
      providerId,
      patch: { name: "新草稿", expectedRevision: 2 },
    }),
  ).toEqual({ providerId, patch: { name: "新草稿", expectedRevision: 2 } });
});
