import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import { shouldEnableWorkspaceRpc } from "@zui/lib/workspaceRpcAvailability";
import { describe, expect, it } from "vitest";

const PROJECT_ID = "8a4a5e2c-7c22-4ad5-9f43-0c3d55f1a234";
const WORKSPACE_PATH = "/workspace/local-project";

describe("本机工作区 RPC 可用性", () => {
  it("无身份的本机目录启用", () => {
    expect(shouldEnableWorkspaceRpc({ workspacePath: WORKSPACE_PATH })).toBe(
      true,
    );
  });

  it("本机项目身份不再被当成远端", () => {
    const identity = canonicalLocalWorkspaceIdentity(
      PROJECT_ID,
      WORKSPACE_PATH,
    );
    expect(
      shouldEnableWorkspaceRpc({
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity: identity,
      }),
    ).toBe(true);
  });

  it("身份与目录不一致时仍按远端收紧", () => {
    const identity = canonicalLocalWorkspaceIdentity(
      PROJECT_ID,
      "/workspace/other-project",
    );
    expect(
      shouldEnableWorkspaceRpc({
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity: identity,
      }),
    ).toBe(false);
  });

  it("未知非空身份按远端收紧", () => {
    expect(shouldEnableWorkspaceRpc({ workspaceIdentity: "remote:abc" })).toBe(
      false,
    );
  });

  it("远端会话恢复后启用", () => {
    expect(
      shouldEnableWorkspaceRpc({
        workspaceIdentity: "remote:abc",
        remoteSessionId: "session-1",
      }),
    ).toBe(true);
  });
});
