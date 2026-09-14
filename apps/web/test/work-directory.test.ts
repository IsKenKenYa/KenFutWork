import { describe, expect, it, vi } from "vitest";

import {
  pickWorkDirectory,
  resolveDirectoryPicker,
  UNSUPPORTED_DIRECTORY_PICKER_NOTICE,
  workDirectoryPromptHint,
} from "../src/lib/work-directory.js";

/**
 * 回归：选择文件夹按钮曾**静默失败**——`showDirectoryPicker` 不可用时直接
 * return（无反馈）、出错被空 catch 吞掉；且只有目录名被当「工作目录」拼进
 * prompt，误导模型以为本机路径可达。
 */
describe("工作目录选择", () => {
  it("环境不支持：返回可展示的说明而非静默", async () => {
    const result = await pickWorkDirectory({});
    expect(result.status).toBe("unsupported");
    expect((result as { notice: string }).notice).toBe(
      UNSUPPORTED_DIRECTORY_PICKER_NOTICE,
    );
  });

  it("window 缺失/畸形：同样给出不支持说明（不抛错）", async () => {
    expect((await pickWorkDirectory(undefined)).status).toBe("unsupported");
    expect((await pickWorkDirectory(null)).status).toBe("unsupported");
    expect(
      (await pickWorkDirectory({ showDirectoryPicker: "not-a-fn" })).status,
    ).toBe("unsupported");
  });

  it("选择成功：返回目录名", async () => {
    const result = await pickWorkDirectory({
      showDirectoryPicker: async () => ({ name: "my-project" }),
    });
    expect(result).toEqual({ status: "picked", name: "my-project" });
  });

  it("目录名为空（部分实现的退化行为）：按取消处理，不写空名", async () => {
    const result = await pickWorkDirectory({
      showDirectoryPicker: async () => ({ name: "   " }),
    });
    expect(result.status).toBe("cancelled");
  });

  it("用户取消（AbortError）：按取消处理，不弹提示", async () => {
    const abort = Object.assign(new Error("user aborted"), {
      name: "AbortError",
    });
    const result = await pickWorkDirectory({
      showDirectoryPicker: async () => {
        throw abort;
      },
    });
    expect(result.status).toBe("cancelled");
  });

  it("其它错误：转为可展示的失败说明（含原因）", async () => {
    const result = await pickWorkDirectory({
      showDirectoryPicker: async () => {
        throw new Error("permission denied by policy");
      },
    });
    expect(result.status).toBe("failed");
    expect((result as { notice: string }).notice).toContain(
      "permission denied by policy",
    );
  });

  it("resolveDirectoryPicker 只认函数（不误绑到其它同名属性）", () => {
    const fn = async () => ({ name: "x" });
    expect(resolveDirectoryPicker({ showDirectoryPicker: fn })).toBe(fn);
    expect(resolveDirectoryPicker({ showDirectoryPicker: 1 })).toBeUndefined();
  });

  it("prompt 提示诚实声明：只有名称、路径不可达、实际在沙箱工作区", () => {
    const hint = workDirectoryPromptHint("my-project");
    expect(hint).toContain("my-project");
    expect(hint).toContain("不可达");
    expect(hint).toContain("沙箱工作区");
    // 不再声称「工作目录」是本机可操作路径
    expect(hint).not.toContain("【工作目录】");
  });
});
