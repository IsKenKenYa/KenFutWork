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
  it("去掉版本注释、按中文名展示、再合并同名家族", () => {
    expect(fontDisplayName("朱雀仿宋（预览测试版）")).toBe("朱雀仿宋（璇玑造字）");
    expect(fontDisplayName("霞鹜文楷 轻便版")).toBe("霞鹜文楷");
    expect(fontDisplayName("Noto Sans CJK SC")).toBe("思源黑体（Adobe·Google）");
    expect(fontDisplayName("Noto Serif CJK SC")).toBe("思源宋体（Adobe·Google）");
    expect(fontDisplayName("Ma Shan Zheng")).toBe("马善政毛笔楷书（Google Fonts）");
    expect(fontDisplayName("ZCOOL KuaiLe")).toBe("站酷快乐体（站酷）");
    expect(fontDisplayName("MiSans")).toBe("小米 MiSans（小米）");
    expect(fontDisplayName("BIZ UDMincho")).toBe("BIZ UDMincho");
    // 列表标注出品方/许可类型（用户口径）。
    expect(fontDisplayName("得意黑")).toBe("得意黑");
    expect(fontDisplayName("抖音美好体")).toBe("抖音美好体（字节跳动）");
    expect(fontDisplayName("更纱黑体 SC")).toBe("更纱黑体");
    // 原来的拉丁字体保持原名。
    expect(fontDisplayName("Inter")).toBe("Inter");
    expect(fontDisplayName("JetBrains Mono")).toBe("JetBrains Mono");

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
    // 站酷快乐体按中文名归入中文段。
    expect(latin).toEqual(["Inter", "Liberation Serif"]);
    expect(cjk).toEqual([
      "得意黑",
      "霞鹜漫黑",
      "悠哉字体",
      "站酷快乐体（站酷）",
    ]);
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
