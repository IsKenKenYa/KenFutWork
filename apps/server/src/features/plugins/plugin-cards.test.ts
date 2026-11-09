import type { PluginCardDeclaration } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { buildBundleManifest } from "./bundle-manifest.js";
import {
  defaultPluginCardLimits,
  truncatePluginCards,
} from "./plugin-cards.js";

const VALID_CARD: PluginCardDeclaration = {
  tools: ["demo_echo", "plugin_tool"],
  title: "插件执行结果",
  fields: [
    { label: "输入", value: "hello" },
    { label: "耗时毫秒", value: 12 },
  ],
  status: "success",
};

function bundleFiles(cards: unknown): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "card-plugin",
      version: "1.0.0",
      type: "module",
      main: "index.js",
      kenfutwork: { bundle: { patch: "./cordis.patch.yml" }, cards },
    }),
    "cordis.patch.yml":
      "- insert:\n    - id: card-plugin\n      name: card-plugin\n",
    "index.js":
      'export const name = "card-plugin";\nexport function apply() {};\n',
  };
}

describe("插件声明式卡片的清单校验", () => {
  it("合法声明被解析，数字值与状态原样保留", () => {
    const { manifest } = buildBundleManifest(bundleFiles([VALID_CARD]));
    expect(manifest.cards).toEqual([VALID_CARD]);
  });

  it("没有 cards 字段时为空数组", () => {
    const { manifest } = buildBundleManifest(bundleFiles(undefined));
    expect(manifest.cards).toEqual([]);
  });

  it("工具名清单为空被拒，消息给出改法", () => {
    expect(() =>
      buildBundleManifest(bundleFiles([{ ...VALID_CARD, tools: [] }])),
    ).toThrowError(/插件卡片声明第 1 条不合法.*tools 与 title 不能为空/);
  });

  it("值不是字符串或数字被拒", () => {
    expect(() =>
      buildBundleManifest(
        bundleFiles([
          {
            ...VALID_CARD,
            fields: [{ label: "输入", value: { text: "hello" } }],
          },
        ]),
      ),
    ).toThrowError(/插件卡片声明第 1 条不合法/);
  });

  it("状态不在清单内被拒", () => {
    expect(() =>
      buildBundleManifest(bundleFiles([{ ...VALID_CARD, status: "unknown" }])),
    ).toThrowError(/插件卡片声明第 1 条不合法/);
  });

  it("键值行超过硬上限被拒并说明请删减", () => {
    const fields = Array.from({ length: 21 }, (_, index) => ({
      label: `字段${index + 1}`,
      value: index,
    }));
    expect(() =>
      buildBundleManifest(bundleFiles([{ ...VALID_CARD, fields }])),
    ).toThrowError(/超过上限 20 行.*请删减/);
  });
});

describe("插件卡片按治理上限裁剪", () => {
  it("超出键值行按声明顺序截掉", () => {
    const fields = Array.from({ length: 5 }, (_, index) => ({
      label: `字段${index + 1}`,
      value: index + 1,
    }));
    const [card] = truncatePluginCards(
      [{ tools: ["demo_echo"], title: "结果", fields, status: null }],
      { maxFields: 2, maxValueCharacters: 120 },
    );
    expect(card?.fields).toEqual(fields.slice(0, 2));
  });

  it("值超过字符上限时保留开头并加省略号，数字不变", () => {
    const [card] = truncatePluginCards(
      [
        {
          tools: ["demo_echo"],
          title: "结果",
          fields: [
            { label: "输出", value: "a".repeat(50) },
            { label: "次数", value: 42 },
          ],
          status: null,
        },
      ],
      { maxFields: 8, maxValueCharacters: 10 },
    );
    expect(card?.fields[0]?.value).toBe(`${"a".repeat(10)}…`);
    expect(card?.fields[1]?.value).toBe(42);
  });

  it("正好等于上限时不加省略号", () => {
    const [card] = truncatePluginCards(
      [
        {
          tools: ["demo_echo"],
          title: "结果",
          fields: [{ label: "输出", value: "1234567890" }],
          status: null,
        },
      ],
      { maxFields: 8, maxValueCharacters: 10 },
    );
    expect(card?.fields[0]?.value).toBe("1234567890");
  });

  it("未传上限时使用治理表缺省值", () => {
    const limits = defaultPluginCardLimits();
    expect(limits.maxFields).toBe(8);
    expect(limits.maxValueCharacters).toBe(120);
    const [card] = truncatePluginCards([VALID_CARD], limits);
    expect(card?.fields).toEqual(VALID_CARD.fields);
  });
});
