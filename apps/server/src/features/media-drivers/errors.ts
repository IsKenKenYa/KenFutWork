export class MediaDriverRegistryError extends Error {
  constructor(
    readonly code:
      | "media_driver_conflict"
      | "media_driver_removed"
      | "media_driver_not_found"
      | "media_driver_storage_error"
      | "media_driver_preview_stale"
      | "media_driver_permissions",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}
