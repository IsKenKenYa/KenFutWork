import { expect, it } from "vitest";
import { resolveModelInputCapabilities } from "./input-capabilities.js";

it.each([
  [{ vision: false }, { imageInput: true }, { image: false, pdf: false }],
  [
    { inputModalities: ["text", "image", "pdf"] },
    undefined,
    { image: true, pdf: true },
  ],
  [
    { inputModalities: ["text"] },
    { imageInput: true },
    { image: false, pdf: false },
  ],
  [
    { vision: false, inputModalities: ["image", "pdf"] },
    undefined,
    { image: false, pdf: true },
  ],
  [{}, { imageInput: true }, { image: true, pdf: false }],
  [{}, undefined, { image: false, pdf: false }],
] as const)(
  "模型显式声明优先于目录hint，PDF按声明开放 %j",
  (model, hints, expected) => {
    expect(resolveModelInputCapabilities(model, hints)).toEqual(expected);
  },
);
