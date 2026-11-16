import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HighlightedMatchText } from "../src/components/workbench/zcode/quickpick/HighlightedMatchText.js";

describe("搜索结果高亮", () => {
  it.each([
    {
      text: "İ Çalışma · İ ÇALIŞMA",
      query: "ÇALIŞMA çalışma",
      marks: ["Çalışma", "ÇALIŞMA"],
    },
    {
      text: "İzma",
      query: "i zm",
      marks: ["İzm"],
    },
    {
      text: "İ 资料 [v2]",
      query: "资料 [v2]",
      marks: ["资料", "[v2]"],
    },
    {
      text: "İ 资料",
      query: "  ",
      marks: [],
    },
    {
      text: "定稿 Final-v2",
      query: "final -v2",
      marks: ["Final-v2"],
    },
    {
      text: "cafe\u0301 notes",
      query: "cafe",
      marks: ["cafe\u0301"],
    },
    {
      text: "任务 👩🏽‍💻 简记",
      query: "💻",
      marks: ["👩🏽‍💻"],
    },
  ])("保留原文并高亮命中范围：$text / $query", ({ text, query, marks }) => {
    const { container } = render(
      <HighlightedMatchText text={text} query={query} />,
    );
    expect(container.textContent).toBe(text);
    expect(
      Array.from(
        container.querySelectorAll("mark"),
        (mark) => mark.textContent,
      ),
    ).toEqual(marks);
  });
});
