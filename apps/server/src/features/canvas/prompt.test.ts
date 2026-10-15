import { expect, it } from "vitest";
import { canvasSelectionPromptSection } from "./prompt.js";

it("选区提示只消费已冻结输入，后续界面选择不进入本Run上下文", async () => {
  const selected = [
    {
      id: "frozen-element",
      type: "rectangle",
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    },
  ];
  const frozen = structuredClone({
    preset: "design" as const,
    canvasId: "original-canvas",
    selectedCanvasElements: selected,
  });
  selected[0]!.id = "later-ui-selection";
  const text = await canvasSelectionPromptSection.resolve({
    preset: "design",
    execution: { workContext: frozen },
  });
  expect(text).toContain('canvas_id="original-canvas"');
  expect(text).toContain("frozen-element");
  expect(text).not.toContain("later-ui-selection");
  expect(text).toContain("不授予文件目录权限");
});
