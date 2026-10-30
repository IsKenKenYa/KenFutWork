import type { WorkFont } from "@kenfutwork/shared";

/**
 * 字体列表的展示模型（纯函数，供 Work 信息页与测试共用）。
 *
 * 上游家族的版本注释会制造重名：「朱雀仿宋（预览测试版）」「霞鹜文楷 轻便版」这类
 * 后缀对用户没有信息量，列表里只留真正的家族名；同名（归一化后）合并成一行。
 */

export type FontFamilyGroup = {
  name: string;
  builtin: boolean;
  userFiles: string[];
};

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u;

/**
 * 字体文件里的家族名常是拉丁转写（Noto Sans CJK SC、Ma Shan Zheng…），对中文用户
 * 等于乱码。这里给有正式中文名的字体配中文显示名；Inter、JetBrains Mono 这类本来就
 * 是拉丁字体，保持原名。只影响列表展示，清单与字体内部名仍是原文。
 */
const DISPLAY_NAMES: Record<string, string> = {
  // 英文转写的字体名 → 中文名。
  "noto sans cjk sc": "思源黑体（开源）",
  "noto serif cjk sc": "思源宋体（开源）",
  "ma shan zheng": "马善政毛笔楷书（开源）",
  "zcool kuaile": "站酷快乐体（站酷）",
  misans: "小米 MiSans（小米）",
  "biz udmincho": "BIZ UD明朝（日文）",
  // 列表里带出品方/许可标注（用户口径：著名的字体在名字后面标一下）。
  "得意黑": "得意黑（开源）",
  "马善政毛笔楷书": "马善政毛笔楷书（开源）",
  "思源黑体": "思源黑体（开源）",
  "思源宋体": "思源宋体（开源）",
  "霞鹜漫黑": "霞鹜漫黑（开源）",
  "霞鹜文楷": "霞鹜文楷（开源）",
  "悠哉字体": "悠哉字体（开源）",
  "站酷快乐体": "站酷快乐体（站酷）",
  "朱雀仿宋": "朱雀仿宋（开源）",
  "抖音美好体": "抖音美好体（开源）",
  "更纱黑体 sc": "更纱黑体（开源）",
  "小米 misans": "小米 MiSans（小米）",
  "biz ud明朝": "BIZ UD明朝（日文）",
};

/** 「朱雀仿宋（预览测试版）」→「朱雀仿宋」；「霞鹜文楷 轻便版」→「霞鹜文楷」。 */
export function fontDisplayName(family: string): string {
  const trimmed = family.trim();
  const known = DISPLAY_NAMES[trimmed.toLowerCase()];
  if (known) return known;
  const stripped = trimmed
    .replace(/[（(][^）)]*[）)]/gu, " ")
    .replace(/\s*(轻便版|预览版|测试版)\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  // 去掉「轻便版」后要再查一次名字表，否则同一家族一半带标注、一半不带。
  const knownAfter = DISPLAY_NAMES[stripped.toLowerCase()];
  if (knownAfter) return knownAfter;
  return stripped || trimmed;
}

/** 英文字体在前、中文字体在后，各自按名称升序；同家族多文件合并为一行。 */
export function fontFamilies(
  fonts: readonly WorkFont[],
): FontFamilyGroup[] {
  const groups = new Map<string, FontFamilyGroup>();
  for (const font of fonts) {
    const name = fontDisplayName(font.family);
    const key = name.toLowerCase();
    const group = groups.get(key);
    if (group) {
      if (!font.builtin) group.userFiles.push(font.fileName);
      group.builtin ||= font.builtin;
    } else {
      groups.set(key, {
        name,
        builtin: font.builtin,
        userFiles: font.builtin ? [] : [font.fileName],
      });
    }
  }
  const cjkRank = (group: FontFamilyGroup) => (CJK.test(group.name) ? 1 : 0);
  return [...groups.values()].sort((a, b) => {
    const rank = cjkRank(a) - cjkRank(b);
    if (rank !== 0) return rank;
    return a.name.localeCompare(b.name, "zh-Hans-CN", { sensitivity: "base" });
  });
}
