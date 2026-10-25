import { describe, expect, it } from "vitest";

import { listWorkEditorRegistrations } from "./registry.js";

describe("编辑器扩展包注册表", () => {
  it("office 三件套齐备（用户核心诉求），图片 / 视频编辑器在册", () => {
    const ids = listWorkEditorRegistrations().map((editor) => editor.id);
    for (const required of [
      "gridcraft",
      "wordcraft",
      "deckcraft",
      "photocraft",
      "filmcraft",
    ]) {
      expect(ids).toContain(required);
    }
  });

  it("注册项 id 唯一、上游指向 storytold、双许可、W1 挂载点全部 wasm-iframe", () => {
    const editors = listWorkEditorRegistrations();
    expect(editors.length).toBeGreaterThanOrEqual(10);
    expect(new Set(editors.map((editor) => editor.id)).size).toBe(editors.length);
    for (const editor of editors) {
      expect(editor.repo).toMatch(/^https:\/\/github\.com\/storytold\//);
      expect(editor.license).toBe("MIT OR Apache-2.0");
      expect(editor.mount).toBe("wasm-iframe");
    }
  });

  it("注册表不含落位事实（installed 由数据目录检查计算，常量与事实分离）", () => {
    for (const editor of listWorkEditorRegistrations()) {
      expect(Object.hasOwn(editor, "installed")).toBe(false);
    }
  });
});
