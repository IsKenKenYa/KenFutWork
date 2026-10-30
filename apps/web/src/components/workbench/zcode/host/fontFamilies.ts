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

/** 「朱雀仿宋（预览测试版）」→「朱雀仿宋」；「霞鹜文楷 轻便版」→「霞鹜文楷」。 */
export function fontDisplayName(family: string): string {
  const stripped = family
    .replace(/[（(][^）)]*[）)]/gu, " ")
    .replace(/\s*(轻便版|预览版|测试版)\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return stripped || family.trim();
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
