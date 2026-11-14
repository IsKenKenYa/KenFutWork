import type { ApplicationErrorCode } from "@kenfutwork/shared";

export class MediaDriverRegistryError extends Error {
  constructor(
    readonly code: Extract<
      ApplicationErrorCode,
      | "media_driver_conflict"
      | "media_driver_removed"
      | "media_driver_not_found"
      | "media_driver_storage_error"
      | "media_driver_preview_stale"
      | "media_driver_permissions"
      | "media_driver_in_use"
    >,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export function isMediaDriverStorageFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return (
    code !== undefined &&
    [
      "ENOENT",
      "EACCES",
      "EPERM",
      "ENOSPC",
      "EROFS",
      "EIO",
      "ELOOP",
      "ENOTDIR",
      "ENAMETOOLONG",
    ].includes(code)
  );
}
