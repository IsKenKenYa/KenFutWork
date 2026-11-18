/** Explicit model declarations are authoritative; catalog hints only fill gaps. */
export function resolveModelInputCapabilities(
  model: {
    vision?: boolean | undefined;
    inputModalities?: readonly string[] | undefined;
  },
  hints?: { imageInput?: boolean | undefined } | undefined,
): { image: boolean; pdf: boolean } {
  return {
    image:
      model.vision ??
      (model.inputModalities
        ? model.inputModalities.includes("image")
        : hints?.imageInput === true),
    pdf: model.inputModalities?.includes("pdf") === true,
  };
}
