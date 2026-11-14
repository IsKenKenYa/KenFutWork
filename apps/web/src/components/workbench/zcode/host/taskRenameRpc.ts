import {
  type CodeTaskOrganizationTarget,
  codeTaskOrganizationTargetSchema,
} from "@kenfutwork/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  canonicalLocalWorkspaceIdentity,
  zcodeTaskMetaSchema,
} from "@zcode/shared";
import {
  type CommandAck,
  type CommandEnvelope,
  commandAckSchema,
  commandsQueryResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { createCommandEnvelope } from "@zui/v4/commandFactory.js";
import { pendingCommandRegistry } from "@zui/v4/pendingCommandRegistry.js";
import { acquireWorkspaceConnection } from "@zui/v4/workspaceConnectionRegistry.js";
import { z } from "zod";
import { assertTaskOperationResult } from "./taskOperationObservation.js";

const renameArgsSchema = z.tuple([
  codeTaskOrganizationTargetSchema.extend({ title: z.string() }),
]);
const renameMetaSchema = zcodeTaskMetaSchema.extend({
  ...codeTaskOrganizationTargetSchema.shape,
  projectId: z.uuid(),
});

export interface TaskRenameCall {
  target: CodeTaskOrganizationTarget;
  envelope: CommandEnvelope;
}

/** 原 UI 意图在任何连接等待前固定，不从当前缓存补充 Task 观察。 */
export function captureTaskRenameCall(
  service: string,
  method: string,
  args: unknown,
): TaskRenameCall | undefined {
  if (service !== "zcode-task" || method !== "renameTask") return undefined;
  const [input] = renameArgsSchema.parse(args);
  if (
    input.workspaceIdentity !==
    canonicalLocalWorkspaceIdentity(
      input.taskControl.projectId,
      input.workspacePath,
    )
  )
    throw new Error("任务身份已改变，请重新加载列表。");
  const target = {
    taskId: input.taskId,
    workspacePath: input.workspacePath,
    workspaceIdentity: input.workspaceIdentity,
    taskControl: structuredClone(input.taskControl),
  };
  return {
    target,
    envelope: createCommandEnvelope({
      type: "renameSession",
      sessionId: target.taskId,
      payload: { title: input.title },
      taskControl: target.taskControl,
    }),
  };
}

function requireAccepted(call: TaskRenameCall, ack: CommandAck) {
  if (ack.commandId !== call.envelope.commandId)
    throw new Error("任务回执不一致，请重新加载任务。");
  pendingCommandRegistry.applyAck(call.envelope, ack);
  if (!["accepted", "duplicate", "noop"].includes(ack.status))
    throw new Error(ack.message ?? "任务改名未接受，请重新加载任务。");
}

/** 只桥接原 V4 命令；结果不明时查询原键，绝不重新发送写入。 */
export async function runTaskRenameCall(
  call: TaskRenameCall,
  context: {
    agentService: IServiceAccessor["zcodeAgentService"];
    requireCurrent(): void;
    readMeta(target: CodeTaskOrganizationTarget): Promise<unknown>;
  },
) {
  context.requireCurrent();
  const workspace = {
    workspacePath: call.target.workspacePath,
    workspaceIdentity: call.target.workspaceIdentity,
  };
  const lease = acquireWorkspaceConnection(workspace, context.agentService);
  try {
    pendingCommandRegistry.record(call.envelope, { workspace });
    let ack: CommandAck;
    try {
      ack = commandAckSchema.parse(
        await lease.transport.sendCommand(call.envelope),
      );
    } catch {
      context.requireCurrent();
      const query = commandsQueryResultSchema.parse(
        await lease.transport.queryCommands({
          commands: [
            {
              sessionId: call.envelope.sessionId,
              commandId: call.envelope.commandId,
            },
          ],
        }),
      );
      context.requireCurrent();
      const result = query.results.find(
        (item) =>
          item.key.sessionId === call.envelope.sessionId &&
          item.key.commandId === call.envelope.commandId,
      )?.result;
      if (
        !result ||
        result === "unknown" ||
        (result.status === "failed" &&
          result.reasonCode === "fault.command.queryUnavailable")
      )
        throw new Error("改名结果尚未确认，请重新连接后查看任务名称。");
      ack = result;
    }
    context.requireCurrent();
    requireAccepted(call, ack);
    const meta = renameMetaSchema.parse(await context.readMeta(call.target));
    context.requireCurrent();
    assertTaskOperationResult(call.target, meta);
    return meta;
  } finally {
    lease.release();
  }
}
