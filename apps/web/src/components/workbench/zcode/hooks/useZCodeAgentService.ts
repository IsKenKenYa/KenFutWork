import type { IZCodeAgentService } from "@zcode/services";
import { useServices } from "@zui/hooks/useServices.js";
import { useWorkspaceServices } from "@zui/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  const services = workspacePath
    ? useWorkspaceServices(workspacePath, preferredRemoteSessionId, workspaceIdentity)
    : useServices();
  return services.zcodeAgentService;
}
