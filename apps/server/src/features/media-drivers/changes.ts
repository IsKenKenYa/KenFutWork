import type { MediaDriverManifest } from "@kenfutwork/shared";

export function describeMediaDriverChanges(
  previous: MediaDriverManifest,
  next: MediaDriverManifest,
) {
  const before = new Map(previous.models.map((model) => [model.id, model]));
  const after = new Map(next.models.map((model) => [model.id, model]));
  return {
    addedModels: next.models
      .filter((model) => !before.has(model.id))
      .map((model) => model.id),
    removedModels: previous.models
      .filter((model) => !after.has(model.id))
      .map((model) => model.id),
    changedModels: next.models
      .filter(
        (model) =>
          before.has(model.id) &&
          JSON.stringify(before.get(model.id)) !== JSON.stringify(model),
      )
      .map((model) => model.id),
    addedOrigins: next.origins.filter(
      (origin) => !previous.origins.includes(origin),
    ),
    removedOrigins: previous.origins.filter(
      (origin) => !next.origins.includes(origin),
    ),
  };
}
