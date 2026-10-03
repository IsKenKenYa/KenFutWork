import type { IChannelClient } from "@zcode/rpc";
import type { IPlatformService } from "@zcode/shared";
import { createWebPlatform } from "./upstream/browserPlatform.js";

/** KenFutWork 提供 BYOK 与自身认证，未提供 ZCode 云账户/套餐能力。 */
export function createCodePlatform(client: IChannelClient): IPlatformService {
  const workspace = client.getChannel("workspace");
  return {
    ...createWebPlatform(),
    supportsCloudAccounts: false,
    async activateOrSetWorkspace(path) {
      await workspace.call("open", [{ path }]);
      return { activated: false };
    },
  };
}
