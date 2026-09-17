import { describe, expect, it, vi } from "vitest";

import {
  boundWorkDirPromptHint,
  pickWorkDirectory,
  resolveDirectoryPicker,
  resolveWorkDirProject,
  UNSUPPORTED_DIRECTORY_PICKER_NOTICE,
  workDirectoryPromptHint,
  workDirNameFromPath,
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

  /**
   * 回归：提示必须点明「工作区根目录就是它」。
   *
   * 只写「目录名称：X」时，真实模型会把 X 当成工作区下的子目录——实测两次
   * （GLM-5.3-Flash 把 kfw-py-demo 建到了 `test/kfw-py-demo/`），用户看到的是
   * 「文件没落在工作目录里」。所以提示里必须有「根目录就是它」+「不要再套同名子目录」。
   */
  it("prompt 明确工作区根目录即该目录，禁止再套一层同名子目录", () => {
    const hint = workDirectoryPromptHint("test");
    expect(hint).toContain("根目录就是它");
    expect(hint).toContain("不要在工作区下再建一个叫「test」的子目录");
    expect(hint).toContain("相对工作区根");
  });

  /**
   * 回归：Code 模式「工作目录=项目」。run 的生产后端要求绑定项目
   * （不绑定会整轮失败：canvasId is required for production backend mode），
   * 选定目录后必须落到一个真实项目上——同名项目复用，没有才新建。
   */
  describe("resolveWorkDirProject（Code：工作目录=项目）", () => {
    const projects = [
      { id: "p1", name: "test" },
      { id: "p2", name: "kfw-demo" },
    ];

    it("目录名与既有项目同名 → 复用（不重复建项目）", () => {
      expect(resolveWorkDirProject("test", projects)).toEqual({
        kind: "reuse",
        projectId: "p1",
      });
      expect(resolveWorkDirProject("kfw-demo", projects)).toEqual({
        kind: "reuse",
        projectId: "p2",
      });
    });

    it("无同名项目 → 按目录名新建", () => {
      expect(resolveWorkDirProject("new-dir", projects)).toEqual({
        kind: "create",
        name: "new-dir",
      });
    });

    it("目录名两侧空白归一后再匹配", () => {
      expect(resolveWorkDirProject("  test  ", projects)).toEqual({
        kind: "reuse",
        projectId: "p1",
      });
    });

    it("空目录名不退化成复用（避免把任意项目当作用域）", () => {
      expect(resolveWorkDirProject("", projects)).toEqual({
        kind: "create",
        name: "",
      });
      expect(resolveWorkDirProject("   ", projects)).toEqual({
        kind: "create",
        name: "",
      });
    });

    it("项目列表为空 → 新建；大小写不同不视为同名", () => {
      expect(resolveWorkDirProject("any", [])).toEqual({
        kind: "create",
        name: "any",
      });
      expect(resolveWorkDirProject("TEST", projects)).toEqual({
        kind: "create",
        name: "TEST",
      });
    });
  });
});

/**
 * 回归（web 形态没法绑定本机目录）：选择器只给得到**目录名**，服务端要的是绝对路径。
 * 现在补上「填本机路径」：路径 → 目录名（项目名）与「已绑定真实目录」的提示词。
 */
describe("手填本机路径（Web 形态绑定真实目录）", () => {
  it("从路径取目录名：两种分隔符都认，末尾分隔符忽略", () => {
    expect(workDirNameFromPath("D:\\Desktop\\test")).toBe("test");
    expect(workDirNameFromPath("D:/Desktop/test")).toBe("test");
    expect(workDirNameFromPath("/home/me/app/")).toBe("app");
    expect(workDirNameFromPath("  /srv/data  ")).toBe("data");
  });

  it("取不出目录名（根路径/空串）返回空串，由调用方兜底", () => {
    expect(workDirNameFromPath("D:\\")).toBe("");
    expect(workDirNameFromPath("/")).toBe("");
    expect(workDirNameFromPath("   ")).toBe("");
  });

  it("不支持目录选择器的说明指向「填本机路径」（不再说做不到）", () => {
    expect(UNSUPPORTED_DIRECTORY_PICKER_NOTICE).toContain("填本机路径");
    expect(UNSUPPORTED_DIRECTORY_PICKER_NOTICE).not.toContain("暂不能直接绑定");
  });

  it("已绑定真实目录的提示词：说出真实路径，但仍要求相对工作区根书写", () => {
    const hint = boundWorkDirPromptHint("D:\\Desktop\\test");
    expect(hint).toContain("D:\\Desktop\\test");
    expect(hint).toContain("根目录");
    expect(hint).toContain("相对工作区根");
    // 不能反过来鼓励绝对路径（工作区外的绝对路径会被沙箱边界拒）
    expect(hint).toContain("不要");
    expect(hint).not.toContain("不可达");
  });
});
