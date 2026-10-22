import {
  type CodeUiViewerScope,
  codeUiViewerScopeSchema,
} from "@kenfutwork/shared";
import { Event, type IChannel, ProxyChannel } from "@zcode/rpc";
import type {
  IFileService,
  IFileWatcherService,
  IServiceAccessor,
} from "@zcode/services";
import { isLocalWorkspaceTarget } from "@zcode/shared";
import type { CodeViewerSource } from "@zui/lib/codeViewer.js";
import type { CodeHttpChannelClient } from "./httpChannelClient.js";

const clientsByFiles = new WeakMap<
  IServiceAccessor["fileService"],
  CodeHttpChannelClient
>();
const missingSourceChannel: IChannel = {
  call: () => Promise.reject(new Error("文件来源不可用，请重新打开文件")),
  listen: () => Event.None,
};
const missingSourceFileServices: Pick<
  IServiceAccessor,
  "fileService" | "fileWatcherService"
> = {
  fileService: ProxyChannel.toService<IFileService>(missingSourceChannel),
  fileWatcherService:
    ProxyChannel.toService<IFileWatcherService>(missingSourceChannel),
};

export interface CodeViewerOrigin {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string | null;
  taskId: string | null;
}

export function registerCodeFileViewerClient(client: CodeHttpChannelClient) {
  clientsByFiles.set(client.services.fileService, client);
}

/** 在打开文件时保留来源；服务端仍逐次校验该 Task 或 Project 的当前授权。 */
export function freezeCodeViewerSource(
  services: IServiceAccessor,
  source: CodeViewerSource,
  origin: CodeViewerOrigin,
): CodeViewerSource {
  const client = clientsByFiles.get(services.fileService);
  if (!client) return source;
  if (source.viewerScope) {
    return {
      ...source,
      viewerScope: Object.freeze(
        codeUiViewerScopeSchema.parse(source.viewerScope),
      ),
    };
  }
  const workspacePath = source.workspacePath ?? origin.workspacePath;
  const workspaceIdentity =
    source.workspaceIdentity ?? origin.workspaceIdentity;
  const remoteSessionId =
    source.workspaceRemoteSessionId ?? origin.workspaceRemoteSessionId;
  if (
    !isLocalWorkspaceTarget({
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
    })
  )
    return source;
  const project = client.projectForPath(workspacePath, workspaceIdentity);
  const scope: CodeUiViewerScope | undefined = origin.taskId
    ? { kind: "task", taskId: origin.taskId }
    : project?.path === workspacePath
      ? { kind: "project", projectId: project.projectId }
      : undefined;
  if (!scope) throw new Error("文件来源不可用，请重新打开文件");
  return {
    ...source,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    viewerScope: Object.freeze(codeUiViewerScopeSchema.parse(scope)),
  };
}

export function codeFileServicesForViewer(
  services: IServiceAccessor,
  scope: CodeUiViewerScope | undefined,
): Pick<IServiceAccessor, "fileService" | "fileWatcherService"> | undefined {
  const client = clientsByFiles.get(services.fileService);
  if (!client) return undefined;
  if (!scope) return missingSourceFileServices;
  return client.fileServicesForViewer(scope);
}
