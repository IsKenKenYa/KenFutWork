import { describe, expect, it } from "vitest";
import { toHelperKeyRequest } from "./executor-helper.js";

describe("Helper 按键组合", () => {
  it("把工具数组当成一个组合键而不是逐键发送", () => {
    expect(toHelperKeyRequest(["command", "a"])).toEqual({
      key: "a",
      modifiers: ["cmd"],
    });
    expect(toHelperKeyRequest(["⌘", "f"])).toEqual({
      key: "f",
      modifiers: ["cmd"],
    });
    expect(toHelperKeyRequest(["ctrl", "shift", "s"])).toEqual({
      key: "s",
      modifiers: ["control", "shift"],
    });
    expect(toHelperKeyRequest(["Enter"])).toEqual({
      key: "enter",
      modifiers: [],
    });
    expect(toHelperKeyRequest(["command+a"])).toEqual({
      key: "a",
      modifiers: ["cmd"],
    });
    expect(toHelperKeyRequest(["command", "+"])).toEqual({
      key: "+",
      modifiers: ["cmd"],
    });
  });

  it("拒绝未知修饰键和空组合", () => {
    expect(() => toHelperKeyRequest(["hyper", "a"])).toThrow("不支持的修饰键");
    expect(() => toHelperKeyRequest([])).toThrow("按键组合不能为空");
  });
});
