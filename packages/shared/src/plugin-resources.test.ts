import { expect, it } from "vitest";
import {
  createPluginIconResourceReference,
  isPluginIconResourceReference,
} from "./plugin-contracts.js";

it("图标引用绑定完整插件身份，Unicode声明与读取路径一致", () => {
  const reference = createPluginIconResourceReference(
    "local__图标",
    "assets/图标.svg",
  );
  expect(reference).toBe(
    "/api/plugins/local__%E5%9B%BE%E6%A0%87/assets/%E5%9B%BE%E6%A0%87.svg",
  );
  expect(isPluginIconResourceReference(reference, "local__图标")).toBe(true);
  expect(isPluginIconResourceReference(reference, "local__other")).toBe(false);
});

it.each([
  "/api/plugins/a/assets/../secret.svg",
  "/api/plugins/a/assets/%2e%2e/secret.svg",
  "/api/plugins/a/assets/%2fsecret.svg",
  "/api/plugins/a/assets/%5csecret.svg",
  "/api/plugins/a/assets/%00.svg",
  "/api/plugins/a/assets/%7f.svg",
  "/api/plugins/%2fother/assets/icon.svg",
  "/api/plugins/a/assets/%zz.svg",
  "/api/plugins/a/assets/icon.svg?token=private",
  "http://outside.invalid/icon.svg",
  "data:image/svg+xml,<svg/>",
])("拒绝越界或非宿主图标引用 %s", (reference) => {
  expect(isPluginIconResourceReference(reference)).toBe(false);
});
