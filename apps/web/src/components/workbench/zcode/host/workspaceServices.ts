import { registerBaseWorkspaceServices } from "@zui/store/remoteWorkspaceSessionStore.js";
import { sidePaneTerminalSessionRegistry } from "@zui/terminal/sidePaneTerminalSessionRegistry.js";
import { bumpTaskListMembershipVersion } from "@zui/v4/taskListMembershipVersion.js";
import type { CodeHttpChannelClient } from "./httpChannelClient.js";
import { bindCodeWorkspaceServiceController } from "./workspaceServiceController.js";

/** 将连接服务快照交回原工作区注册链。 */
export function bindCodeWorkspaceServices(client: CodeHttpChannelClient) {
  let services = client.services;
  registerBaseWorkspaceServices(client.services);
  const releaseController = bindCodeWorkspaceServiceController(client);
  const releaseServices = client.subscribeServices(() => {
    if (services !== client.services) {
      sidePaneTerminalSessionRegistry.releaseByPredicate((entry) =>
        client.ownsTerminal(entry.terminalId),
      );
      services = client.services;
    }
    registerBaseWorkspaceServices(client.services);
    // 断线期间的 membership 事件可能丢失，沿原版本链重读持久 Task 左表。
    bumpTaskListMembershipVersion();
  });
  return () => {
    releaseServices();
    releaseController();
    sidePaneTerminalSessionRegistry.releaseByPredicate((entry) =>
      client.ownsTerminal(entry.terminalId),
    );
  };
}
