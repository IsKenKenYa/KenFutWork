import { describe, expect, it } from "vitest";
import {
  fontDisplayName,
  fontFamilies,
} from "@/components/workbench/zcode/host/fontFamilies";
import type { WorkFont } from "@kenfutwork/shared";

function font(
  family: string,
  fileName: string,
  builtin: boolean,
): WorkFont {
  return { family, fileName, format: "ttf", bytes: 1, builtin };
}

describe("字体列表展示", () => {
  it("去掉版本注释再合并同名家族", () => {
    expect(fontDisplayName("朱雀仿宋（预览测试版）")).toBe("朱雀仿宋");
    expect(fontDisplayName("霞鹜文楷 轻便版")).toBe("霞鹜文楷");
    expect(fontDisplayName("Noto Sans CJK SC")).toBe("Noto Sans CJK SC");

    const groups = fontFamilies([
      font("霞鹜文楷 轻便版", "bundled-LXGWWenKaiLite-Regular.ttf", true),
      font("霞鹜文楷 轻便版", "abc-upload.ttf", false),
      font("霞鹜文楷", "def-full.ttf", false),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      name: "霞鹜文楷",
      builtin: true,
    });
    expect(groups[0]!.userFiles).toEqual(["abc-upload.ttf", "def-full.ttf"]);
  });

  it("英文字体在前、中文在后，各自升序", () => {
    const groups = fontFamilies([
      font("霞鹜漫黑", "b.ttf", true),
      font("ZCOOL KuaiLe", "c.ttf", true),
      font("得意黑", "d.ttf", true),
      font("Inter", "e.ttf", true),
      font("悠哉字体", "f.ttf", true),
      font("Liberation Serif", "g.ttf", true),
    ]);
    const names = groups.map((group) => group.name);
    const latinCount = names.findIndex((name) => /[\u3400-\u9fff]/u.test(name));
    expect(latinCount).toBeGreaterThan(0);
    const latin = names.slice(0, latinCount);
    const cjk = names.slice(latinCount);
    expect(latin).toEqual(["Inter", "Liberation Serif", "ZCOOL KuaiLe"]);
    expect(cjk).toHaveLength(3);
    for (const name of cjk) expect(name).toMatch(/[\u3400-\u9fff]/u);
    const sorted = [...cjk].sort((a, b) =>
      a.localeCompare(b, "zh-Hans-CN", { sensitivity: "base" }),
    );
    expect(cjk).toEqual(sorted);
  });

  it("内置家族即便有用户副本也标记为内置（列表不给删除入口）", () => {
    const [group] = fontFamilies([
      font("Inter", "bundled-Inter-Regular.ttf", true),
      font("Inter", "abc-user-inter.ttf", false),
    ]);
    expect(group).toMatchObject({ name: "Inter", builtin: true });
    expect(group!.userFiles).toEqual(["abc-user-inter.ttf"]);
  });
});
