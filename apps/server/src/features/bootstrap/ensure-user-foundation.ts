import { type ViewerResponse, viewerResponseSchema } from "@loomic/shared";

import type { AuthenticatedUser } from "../../supabase/user.js";
import { BootstrapError, ProfileUpdateError } from "./errors.js";
import type { ViewerProfileRecord, ViewerRepository } from "./repository.js";

export { BootstrapError, ProfileUpdateError } from "./errors.js";

/** 工作区摘要（契约类型取自 viewer 响应，避免第二份定义）。 */
export type ViewerWorkspace = ViewerResponse["workspace"];

export type ViewerService = {
  ensureViewer(user: AuthenticatedUser): Promise<ViewerResponse>;
  /**
   * 解析用户当前工作区（目标态：个人工作区；桌面单用户即本机工作区）。
   * 其它聚合一律经此取工作区，不各自拼同一查询；缺失即抛 `BootstrapError`。
   */
  resolveWorkspace(user: AuthenticatedUser): Promise<ViewerWorkspace>;
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

  const resolveWorkspace: ViewerService["resolveWorkspace"] = async (user) => {
    const workspace = await guard(() =>
      repository.findPersonalWorkspace(user.id),
    );

    if (!workspace) {
      throw new BootstrapError();
    }

    return workspace;
  };

  return {
    async ensureViewer(user) {
      await guard(() =>
        repository.bootstrap({
          email: user.email,
          userMeta: user.userMetadata,
          userId: user.id,
        }),
      );

      const workspace = await resolveWorkspace(user);

      const [profile, membership] = await Promise.all([
        guard(() => repository.findProfile(user.id)),
        guard(() => repository.findMembership(workspace.id, user.id)),
      ]);

      if (!profile || !membership) {
        throw new BootstrapError();
      }

      return viewerResponseSchema.parse({ membership, profile, workspace });
    },

    resolveWorkspace,

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
