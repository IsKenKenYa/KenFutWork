/**
 * workspace prepare 的协议 RPC 收口。
 *
 * 拆出原因：useWorkspacePrepare.ts 只保留可单测的轻量判定入口；
 * 只读原workspace-config完整投影；复用现有连接租约，不创建Task或启动Agent运行。
 */
import type { ZCodeProvider, ZCodeWorkspacePrepareResult } from "@zcode/shared";
import { getChatErrorMessage } from "@zui/lib/chatPrepareError.js";
import { logger } from "@zui/logger.js";
import {
  acquireWorkspaceConnection,
  type WorkspaceConnectionAgentService,
} from "@zui/v4/workspaceConnectionRegistry.js";

export async function prepareWorkspaceWithZCodeSessionService(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider: ZCodeProvider;
  agentService: WorkspaceConnectionAgentService;
  remoteSessionId?: string;
}): Promise<ZCodeWorkspacePrepareResult> {
  const startedAt = Date.now();
  logger.info("[zcode-workspace-presentation] workspace prepare start", {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity ?? null,
    provider: params.provider,
  });

  const lease = acquireWorkspaceConnection(
    {
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      remoteSessionId: params.remoteSessionId,
    },
    params.agentService,
  );
  try {
    lease.activateRemoteService();
    const config = await lease.readWorkspaceConfig();
    logger.info("工作区配置准备完成", {
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity ?? null,
      provider: params.provider,
      durationMs: Date.now() - startedAt,
      configOptionsCount: config.configOptions.length,
    });
    return {
      workspacePath: params.workspacePath,
      preparedSessionId: "",
      version: "ZCode Protocol/1",
      provider: params.provider,
      configOptions: config.configOptions,
      slashCommands: config.slashCommands,
    };
  } catch (error) {
    logger.warn(
      "[zcode-workspace-presentation] readWorkspacePresentation failed",
      {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? null,
        provider: params.provider,
        durationMs: Date.now() - startedAt,
        error: getChatErrorMessage(error),
      },
    );
    throw error;
  } finally {
    lease.release();
  }
}
