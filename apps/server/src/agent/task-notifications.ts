import { HumanMessage } from "@langchain/core/messages";
import type { AgentMiddleware } from "langchain";

import type { BackgroundTaskNotification } from "./background-tasks.js";

/**
 * 后台任务通知的消息形态（DEC-15）：模型可见与用户可见是**同一份事实**——
 * 服务端把它作为 user 消息注入下一轮模型输入（zcode `<task-notification>` 同款
 * XML 系统提醒形态），同时经 `task.notification` 流事件推给前端渲染通知行。
 */

export function formatTaskNotificationsXml(
  notifications: readonly BackgroundTaskNotification[],
): string {
  const bodies = notifications
    .map((n) => {
      const nextStep = n.nextStep
        ? `\n<next_step>${n.nextStep}</next_step>`
        : "";
      return (
        `<task-notification task_id="${n.taskId}" kind="${n.kind}" ` +
        `status="${n.status}">\n<label>${n.label}</label>\n` +
        `<summary>${n.summary}</summary>${nextStep}\n</task-notification>`
      );
    })
    .join("\n");
  return (
    "<task-notifications>\n" +
    "以下是后台任务的结算结果（结果摘要已注入；需要细节可用 task_output 查询）：\n" +
    bodies +
    "\n</task-notifications>"
  );
}

/**
 * mailbox 中间件：每次模型调用前把已结算未消费的通知注入消息列表。
 * 可行性依据（deepagents 1.14 / langchain 1.5）：beforeModel 返回的
 * `{messages}` 经 addMessages reducer 追加进下一轮模型输入。
 */
export function createTaskNotificationMiddleware(registry: {
  drainNotifications: () => BackgroundTaskNotification[];
}): AgentMiddleware {
  return {
    name: "backgroundTaskNotifications",
    beforeModel: () => {
      const notifications = registry.drainNotifications();
      if (notifications.length === 0) return {};
      return {
        messages: [new HumanMessage(formatTaskNotificationsXml(notifications))],
      };
    },
  } as unknown as AgentMiddleware;
}
