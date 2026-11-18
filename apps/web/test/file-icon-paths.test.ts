import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveIconName } from "../src/components/workbench/zcode/lib/fileDisplayHelpers";
import {
  hasMaterialIcon,
  MATERIAL_ICON_NAMES,
} from "../src/components/workbench/zcode/lib/materialIconNames";

// vitest 的 cwd 是 apps/web，直接按仓库相对路径取素材目录（jsdom 下 import.meta.url 不是 file:）。
const ICON_DIR = path.resolve(
  process.cwd(),
  "src/components/workbench/zcode/public/material-icons",
);

describe("文件图标路径", () => {
  it("未知扩展名回退 document，不再拼出不存在的 <ext>.svg", () => {
    for (const filePath of ["notes.text", "Main.kt", "debug.unknownext"]) {
      expect(resolveIconName(filePath)).toBe("document");
    }
    expect(hasMaterialIcon("text")).toBe(false);
    expect(hasMaterialIcon("kt")).toBe(false);
  });

  it("有素材的扩展名与文件别名保持原图标", () => {
    expect(resolveIconName("index.ts")).toBe("typescript");
    expect(resolveIconName("App.tsx")).toBe("react_ts");
    expect(resolveIconName("main.rs")).toBe("rust");
    expect(resolveIconName("feed.xml")).toBe("xml");
    expect(resolveIconName(".env")).toBe("settings");
    expect(resolveIconName("README")).toBe("readme");
  });

  it("`.text` 回退到 document 图标，该素材真实存在，text.svg 不在清单里", () => {
    const iconName = resolveIconName("notes.text");
    expect(iconName).toBe("document");
    expect(MATERIAL_ICON_NAMES.has(iconName)).toBe(true);
    expect(MATERIAL_ICON_NAMES.has("text")).toBe(false);
  });

  it("清单与 material-icons 目录逐项一致", () => {
    const files = readdirSync(ICON_DIR)
      .filter((name) => name.endsWith(".svg"))
      .map((name) => name.slice(0, -".svg".length));
    expect(new Set(files)).toEqual(new Set(MATERIAL_ICON_NAMES));
  });
});
