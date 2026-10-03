import type { IChannelClient } from "@zcode/rpc";
import type { IPlatformService } from "@zcode/shared";
import { createWebPlatform } from "./upstream/browserPlatform.js";

/** KenFutWork 宿主仅声明已接通的能力。 */
export function createCodePlatform(client: IChannelClient): IPlatformService {
  const workspace = client.getChannel("workspace");
  return {
    ...createWebPlatform(),
    supportsCloudAccounts: false,
    // 当前 Code 通道尚未提供对应服务；能力接通前不展示可操作入口。
    supportsAutomations: false,
    supportsEmbeddedBrowser: false,
    supportsComputerUse: false,
    supportsRemoteWorkspaces: false,
    async activateOrSetWorkspace(path) {
      await workspace.call("open", [{ path }]);
      return { activated: false };
    },
  };
}
