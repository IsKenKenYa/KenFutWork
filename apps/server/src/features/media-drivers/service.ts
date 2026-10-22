import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { SettingsService } from "../settings/settings-service.js";
import { previewMediaDriverSource } from "./preview.js";

export type MediaDriverFile = Awaited<
  ReturnType<typeof previewMediaDriverSource>
>;

export interface MediaDriverService {
  preview(actor: LocalActor, source: string): Promise<MediaDriverFile>;
}

export function createMediaDriverService(deps: {
  localInstance: LocalInstanceService;
  settings: SettingsService;
}): MediaDriverService {
  return {
    async preview(actor, source) {
      const { instanceId } = await deps.localInstance.resolve(actor);
      const settings = await deps.settings.getInstanceSettings(
        actor,
        instanceId,
      );
      return previewMediaDriverSource(source, {
        maxBytes: settings.mediaDriverMaxSourceBytes,
      });
    },
  };
}
