import {
  bindRemoteWorkspaceIdentity,
  getRemoteWorkspaceSession,
  registerRemoteWorkspaceSession,
  unbindRemoteWorkspaceIdentity,
  unregisterRemoteWorkspaceSession,
} from "@zui/store/remoteWorkspaceSessionStore.js";
import type { CodeHttpChannelClient } from "./httpChannelClient.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";

/** Root layout阶段给出明确目标；请求时读取该桶当前真实Task，失败不会退借其它Project。 */
export function createCodeWorkspaceContextResolver(
  client: CodeHttpChannelClient,
) {
  return (target: {
    workspacePath: string | null;
    workspaceIdentity: string | null;
  }) => {
    client.setViewerContextResolver(() => {
      if (!target.workspacePath) return null;
      const taskId = useZCodeSessionStore
        .getState()
        .getWorkspaceState(
          target.workspacePath,
          target.workspaceIdentity ?? undefined,
        ).activeTaskId;
      if (taskId) return { kind: "task", taskId };
      const project = client.projectForPath(
        target.workspacePath,
        target.workspaceIdentity,
      );
      return project ? { kind: "project", projectId: project.projectId } : null;
    });
  };
}

/** 原 Renderer 的 identity target 必须有真实服务attachment；宿主只登记已观察的DTO/meta。 */
export function bindCodeWorkspaceServiceController(
  client: CodeHttpChannelClient,
) {
  const sessionId = `code-host-${crypto.randomUUID()}`;
  let registeredServices = client.services;
  let registered = false;
  const identities = new Set<string>();
  const synchronize = () => {
    const current = new Set(
      client.workspaces
        .knownWorkspaces()
        .map((entry) => entry.workspaceIdentity),
    );
    if (
      current.size &&
      (!registered || registeredServices !== client.services)
    ) {
      registeredServices = client.services;
      registerRemoteWorkspaceSession({
        sessionId,
        services: registeredServices,
      });
      registered = true;
    }
    for (const identity of identities) {
      if (current.has(identity)) continue;
      unbindRemoteWorkspaceIdentity(identity);
      identities.delete(identity);
    }
    for (const identity of current) {
      if (identities.has(identity)) continue;
      bindRemoteWorkspaceIdentity(identity, sessionId);
      identities.add(identity);
    }
    if (!current.size && registered) {
      unregisterRemoteWorkspaceSession(sessionId);
      registered = false;
    }
  };
  synchronize();
  const releaseWorkspaces = client.workspaces.subscribe(synchronize);
  const releaseServices = client.subscribeServices(synchronize);
  return () => {
    releaseWorkspaces();
    releaseServices();
    for (const identity of identities) unbindRemoteWorkspaceIdentity(identity);
    identities.clear();
    if (getRemoteWorkspaceSession(sessionId)?.services === registeredServices)
      unregisterRemoteWorkspaceSession(sessionId);
  };
}
