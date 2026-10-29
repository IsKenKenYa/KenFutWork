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

  it("注册项 id 唯一、上游可溯、许可自洽、全部内嵌挂载", () => {
    const editors = listWorkEditorRegistrations();
    expect(editors.length).toBeGreaterThanOrEqual(10);
    expect(new Set(editors.map((editor) => editor.id)).size).toBe(
      editors.length,
    );
    for (const editor of editors) {
      expect(editor.mount).toBe("wasm-iframe");
      expect(editor.repo).toMatch(/^https:\/\//);
      expect(editor.license).not.toBe("");
    }
  });

  it("自建的 EDA 编辑器不提供下载：站点随仓库分发，pinned 为空", () => {
    const builtin = listWorkEditorRegistrations().filter(
      (editor) => editor.id === "kicad",
    );
    expect(builtin).toHaveLength(1);
    expect(builtin[0]?.pinned).toBeNull();
    expect(builtin[0]?.category).toBe("eda");
  });

  it("注册表不含落位事实（installed 由数据目录检查计算，常量与事实分离）", () => {
    for (const editor of listWorkEditorRegistrations()) {
      expect(Object.hasOwn(editor, "installed")).toBe(false);
    }
  });

  it("gridcraft 已锚定发布（W2 首个编辑器）：字节数与 sha256 形状合法、资产名与版本自洽", () => {
    const gridcraft = listWorkEditorRegistrations().find(
      (editor) => editor.id === "gridcraft",
    );
    expect(gridcraft?.pinned).not.toBeNull();
    const pinned = gridcraft?.pinned;
    expect(pinned?.asset).toBe(`gridcraft-web-${pinned?.version}.zip`);
    expect(pinned?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(pinned?.bytes).toBeGreaterThan(1_000_000);
    expect(pinned?.url).toBe(
      `https://github.com/storytold/gridcraft/releases/download/v${pinned?.version}/${pinned?.asset}`,
    );
  });

  it("上游 12 个扩展包全部锚定：资产名/版本/URL 自洽、sha256 形状合法", () => {
    const editors = listWorkEditorRegistrations().filter(
      (editor) => editor.pinned !== null,
    );
    expect(editors).toHaveLength(12);
    for (const editor of editors) {
      const pinned = editor.pinned;
      expect(pinned, `${editor.id} 未锚定`).not.toBeNull();
      expect(pinned?.asset).toBe(`${editor.id}-web-${pinned?.version}.zip`);
      expect(pinned?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(pinned?.bytes).toBeGreaterThan(1_000_000);
      expect(pinned?.url).toBe(
        `https://github.com/storytold/${editor.id}/releases/download/v${pinned?.version}/${pinned?.asset}`,
      );
    }
  });
});
