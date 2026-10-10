import type { IZCodeSessionService } from "@zcode/services";
import { useWorkspaceServices } from "@zui/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  const services = useWorkspaceServices(workspacePath, preferredRemoteSessionId, workspaceIdentity);
  return services.zcodeSessionService;
}
