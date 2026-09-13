const BOOTSTRAP_FAILED_MESSAGE = "Unable to prepare viewer workspace.";
const PROFILE_UPDATE_FAILED_MESSAGE = "Unable to update profile.";

/** 用户/工作区引导失败（HTTP 500，`bootstrap_failed`）。 */
export class BootstrapError extends Error {
  readonly code = "bootstrap_failed";
  readonly statusCode = 500;

  constructor() {
    super(BOOTSTRAP_FAILED_MESSAGE);
    this.name = "BootstrapError";
  }
}

/** profile 更新失败（HTTP 500，`profile_update_failed`）。 */
export class ProfileUpdateError extends Error {
  readonly code = "profile_update_failed";
  readonly statusCode = 500;

  constructor() {
    super(PROFILE_UPDATE_FAILED_MESSAGE);
    this.name = "ProfileUpdateError";
  }
}
