import { type ViewerResponse, viewerResponseSchema } from "@loomic/shared";

import type { AuthenticatedUser } from "../../supabase/user.js";
import { BootstrapError, ProfileUpdateError } from "./errors.js";
import type { ViewerProfileRecord, ViewerRepository } from "./repository.js";

export { BootstrapError, ProfileUpdateError } from "./errors.js";

export type ViewerService = {
  ensureViewer(user: AuthenticatedUser): Promise<ViewerResponse>;
  /** 更新当前登录用户的显示名；失败抛 `ProfileUpdateError`。 */
  updateProfile(
    user: AuthenticatedUser,
    displayName: string,
  ): Promise<ViewerProfileRecord>;
};

export function createViewerService(options: {
  repository: ViewerRepository;
}): ViewerService {
  const { repository } = options;

  return {
    async ensureViewer(user) {
      await guard(() =>
        repository.bootstrap({
          email: user.email,
          userMeta: user.userMetadata,
          userId: user.id,
        }),
      );

      const workspace = await guard(() =>
        repository.findPersonalWorkspace(user.id),
      );

      if (!workspace) {
        throw new BootstrapError();
      }

      const [profile, membership] = await Promise.all([
        guard(() => repository.findProfile(user.id)),
        guard(() => repository.findMembership(workspace.id, user.id)),
      ]);

      if (!profile || !membership) {
        throw new BootstrapError();
      }

      return viewerResponseSchema.parse({ membership, profile, workspace });
    },

    async updateProfile(user, displayName) {
      const profile = await repository
        .updateDisplayName(user.id, displayName)
        .catch(() => {
          throw new ProfileUpdateError();
        });

      if (!profile) {
        throw new ProfileUpdateError();
      }

      return profile;
    },
  };
}

/** 数据访问失败一律折叠为 `BootstrapError`（保持既有 HTTP 契约）。 */
async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BootstrapError) {
      throw error;
    }
    throw new BootstrapError();
  }
}
