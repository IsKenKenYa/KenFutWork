// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CodeUiViewerScope,
  codeUiWorkspaceSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import type { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import type { PublicFixture } from "./setup/code-public-session";

const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);
type TaskSource = {
  sessionId: string;
  projectId: string;
  workspacePath: string;
};
type TaskFixture = TaskSource & {
  clientId: string;
  client: Pick<PublicFixture["client"], "request">;
  snapshot(): Promise<unknown>;
  dispose(): Promise<void>;
};

async function withFileTargets(
  check: (context: {
    client: CodeHttpChannelClient;
    first: TaskFixture;
    second: TaskSource;
    sourcePath: string;
    original: Buffer;
  }) => Promise<void>,
) {
  const fixtureLoading: Promise<{
    createCodeUiHttpFixture(): Promise<PublicFixture>;
  }> = import(fixturePath);
  const [http, sessions] = await Promise.all([
    fixtureLoading,
    import("../../server/src/features/code-ui/host-session.fixture.js"),
  ]);
  const fixture = await http.createCodeUiHttpFixture();
  let first: TaskFixture | undefined;
  let secondProjectId: string | undefined;
  let disposeClient: (() => void) | undefined;
  try {
    first = await sessions.createCodeSessionFixture(fixture.baseUrl, {
      client: fixture.client,
    });
    const firstSnapshot = protocol.conversationSnapshotSchema.parse(
      await first.snapshot(),
    );
    const modelSelection = firstSnapshot.config.modelSelection;
    if (!modelSelection)
      throw new Error("固定文件来源验收需要 Task A 的真实模型选择");
    const secondDirectory = join(first.workspacePath, "task-b");
    await mkdir(secondDirectory);
    const opened = await first.client.request("/api/code-ui/rpc", {
      service: "workspace",
      method: "open",
      args: [{ path: secondDirectory }],
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const secondWorkspace = codeUiWorkspaceSchema.parse(opened.body.result);
    secondProjectId = secondWorkspace.projectId;
    const created = await first.client.request("/api/code-ui/rpc", {
      service: "zcodeAgentService",
      method: "sendConversationCommandV4",
      args: [
        {
          workspacePath: secondWorkspace.path,
          projectId: secondProjectId,
          envelope: {
            commandId: randomUUID(),
            clientId: first.clientId,
            sessionId: null,
            type: "createSession",
            payload: {
              workspaceId: secondProjectId,
              config: { modelSelection },
            },
            issuedAt: Date.now(),
          },
        },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const ack = protocol.commandAckSchema.parse(created.body.result);
    if (ack.status !== "accepted" || ack.result?.type !== "createSession")
      throw new Error("固定文件来源验收未创建 Task B");
    const second = {
      sessionId: ack.result.sessionId,
      projectId: secondProjectId,
      workspacePath: secondWorkspace.path,
    };
    const original = Buffer.from(
      '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16">\r\n' +
        "<!-- Task A 原始图片🙂 -->\r\n" +
        '<rect width="24" height="16" fill="red"/>\r\n</svg>\r\n',
      "utf8",
    );
    const sourcePath = join(first.workspacePath, "source.svg");
    await writeFile(sourcePath, original);
    await writeFile(
      join(second.workspacePath, "source.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><title>Task B</title></svg>',
    );
    const { CodeHttpChannelClient } = await import(
      "../src/components/workbench/zcode/host/httpChannelClient"
    );
    const client = new CodeHttpChannelClient({
      apiBase: fixture.baseUrl,
      accessToken: await fixture.app.kernel
        .get("localAccess")
        .getDesktopToken(),
    });
    disposeClient = () => client.dispose();
    await client.connect();
    await client.openWorkspace(first.workspacePath, first.projectId);
    await client.openWorkspace(second.workspacePath, second.projectId);
    const active: CodeUiViewerScope = {
      kind: "task",
      taskId: second.sessionId,
    };
    client.setViewerContextResolver(() => active);
    await check({ client, first, second, sourcePath, original });
  } finally {
    disposeClient?.();
    try {
      if (secondProjectId && first) {
        const deleted = await first.client.request(
          `/api/projects/${secondProjectId}`,
          undefined,
          "DELETE",
        );
        expect(deleted.status, "固定文件来源验收未能清理项目 B").toBeLessThan(
          400,
        );
      }
    } finally {
      try {
        await first?.dispose();
      } finally {
        await fixture.close();
      }
    }
  }
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "固定文件来源公开接线 integration",
  () => {
    it("当前选择 Task B 时固定 Task A 的文件服务仍读取 A 的完整 SVG 原字节", async () => {
      await withFileTargets(async ({ client, first, sourcePath, original }) => {
        const files = client.fileServicesForViewer({
          kind: "task",
          taskId: first.sessionId,
        });
        const preview = await files.fileService.readMediaPreview({
          path: sourcePath,
        });
        expect(Buffer.from(preview.dataBase64, "base64")).toStrictEqual(
          original,
        );
      });
    }, 120_000);

    it("删除 Task A 后固定代理的迟到读取被拒绝且不会读取当前 Task B 的同名文件", async () => {
      await withFileTargets(async ({ client, first, second, original }) => {
        const files = client.fileServicesForViewer({
          kind: "task",
          taskId: first.sessionId,
        });
        const beforeDelete = await files.fileService.readMediaPreview({
          path: "source.svg",
        });
        expect(Buffer.from(beforeDelete.dataBase64, "base64")).toStrictEqual(
          original,
        );
        const beforeSnapshot = await first.client.request(
          `/api/code-ui/sessions/${first.sessionId}`,
        );
        expect(beforeSnapshot.status).toBe(200);

        await client.services.zcodeTaskService.deleteTask({
          taskId: first.sessionId,
          workspacePath: first.workspacePath,
          workspaceIdentity: JSON.stringify([
            first.projectId,
            first.workspacePath,
          ]),
        });

        await expect(
          files.fileService.readMediaPreview({ path: "source.svg" }),
        ).rejects.toMatchObject({
          status: 404,
          code: "code_ui_task_not_found",
        });
        const currentFiles = client.fileServicesForViewer({
          kind: "task",
          taskId: second.sessionId,
        });
        const currentPreview = await currentFiles.fileService.readMediaPreview({
          path: "source.svg",
        });
        expect(
          Buffer.from(currentPreview.dataBase64, "base64").toString(),
        ).toBe(
          '<svg xmlns="http://www.w3.org/2000/svg"><title>Task B</title></svg>',
        );
        await expect(
          files.fileService.readMediaPreview({ path: "source.svg" }),
        ).rejects.toMatchObject({
          status: 404,
          code: "code_ui_task_not_found",
        });
        const afterLateReads = await first.client.request(
          `/api/code-ui/sessions/${first.sessionId}`,
        );
        expect(afterLateReads.status).toBe(404);
      });
    }, 120_000);

    it("Task B 打开项目 A 路径时不能借项目默认目录读取 Task B 未授权文件", async () => {
      await withFileTargets(async ({ client, first, second, sourcePath }) => {
        const targets = await import(
          "../src/components/workbench/zcode/host/fileViewerServices"
        );
        const source = targets.freezeCodeViewerSource(
          client.services,
          {
            type: "file",
            title: "source.svg",
            path: sourcePath,
            workspacePath: first.workspacePath,
            workspaceIdentity: JSON.stringify([
              first.projectId,
              first.workspacePath,
            ]),
          },
          {
            workspacePath: second.workspacePath,
            workspaceIdentity: JSON.stringify([
              second.projectId,
              second.workspacePath,
            ]),
            taskId: second.sessionId,
          },
        );
        const files = targets.codeFileServicesForViewer(
          client.services,
          source.viewerScope,
        );
        if (!files) throw new Error("固定文件来源服务未连接");

        await expect(
          files.fileService.readMediaPreview({ path: sourcePath }),
        ).rejects.toMatchObject({ status: 404, code: "code_ui_path_denied" });
      });
    }, 120_000);
  },
);
