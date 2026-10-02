import type { IPlatformService } from "@zcode/shared";
import { createWebPlatform } from "./upstream/browserPlatform.js";

/** KenFutWork 提供 BYOK 与自身认证，未提供 ZCode 云账户/套餐能力。 */
export function createCodePlatform(): IPlatformService {
  return { ...createWebPlatform(), supportsCloudAccounts: false };
}
