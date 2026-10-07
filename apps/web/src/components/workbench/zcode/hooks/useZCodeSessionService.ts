import type { IZCodeSessionService } from "@zcode/services";
import { useServices } from "@zui/hooks/useServices.js";
import { useWorkspaceServices } from "@zui/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  const services = workspacePath
    ? useWorkspaceServices(workspacePath, preferredRemoteSessionId, workspaceIdentity)
    : useServices();
  return services.zcodeSessionService;
}
