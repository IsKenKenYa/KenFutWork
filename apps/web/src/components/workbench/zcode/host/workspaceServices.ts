import { registerBaseWorkspaceServices } from "@zui/store/remoteWorkspaceSessionStore.js";
import { bumpTaskListMembershipVersion } from "@zui/v4/taskListMembershipVersion.js";
import type { CodeHttpChannelClient } from "./httpChannelClient.js";

/** 将连接服务快照交回原工作区注册链。 */
export function bindCodeWorkspaceServices(client: CodeHttpChannelClient) {
  registerBaseWorkspaceServices(client.services);
  return client.subscribeServices(() => {
    registerBaseWorkspaceServices(client.services);
    // 断线期间的 membership 事件可能丢失，沿原版本链重读持久 Task 左表。
    bumpTaskListMembershipVersion();
  });
}
