export interface MediaModelPreference {
  mode: "auto" | "manual";
  models: string[];
}
export function toggleMediaModel(
  preference: MediaModelPreference,
  model: string,
): MediaModelPreference {
  if (preference.mode === "auto") return { mode: "manual", models: [model] };
  const selected = preference.models.includes(model);
  if (selected && preference.models.length === 1) return preference;
  return {
    mode: "manual",
    models: selected
      ? preference.models.filter((item) => item !== model)
      : [...preference.models, model],
  };
}
