import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { createAgent, FakeToolCallingModel } from "langchain";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  AGENT_GOVERNANCE_LIMITS,
  zcodeUiProtocol as protocol,
  type StreamEvent,
} from "@kenfutwork/shared";
import { kernelToolToStructuredTool } from "../../agent/kernel-tools-bridge.js";
import { adaptDeepAgentStream } from "../../agent/stream-adapter.js";
import { AgentRunEventBus, ToolRegistryImpl } from "../../kernel/context.js";
import { createCodeFileTools } from "../code-tools/tool-definitions.js";
import {
  createScopedBackend,
  type ScopedFilesystemScope,
} from "../execution/scoped-filesystem.js";
import { createCodeUiConversation } from "./conversation.js";
import { createToolLifecycleMiddleware } from "./tool-lifecycle.js";

/** 外部文件域临时夹具，真实native工具/bridge/Harness事实/原V4 schema均保持生产实现。 */
export async function createFileDisplayPublicFixture(
  multipleFiles = false,
  truncatePreview = false,
) {
  const rootDirectory = await mkdtemp(
    join(tmpdir(), "kfw-public-file-display-"),
  );
  const filePath = join(rootDirectory, "example.ts");
  // 两个非相邻完整hunk各自可展示，合计超过最小治理预算；文件仍可真实提交。
  const originalContent = truncatePreview
    ? `first${"x".repeat(300)}\nsame\nsame\nsame\nfirst${"x".repeat(300)}\n`
    : "first\nsame\n";
  await writeFile(filePath, originalContent);
  if (multipleFiles) await writeFile(join(rootDirectory, "other.ts"), "left\n");
  const taskId = randomUUID();
  const runId = randomUUID();
  const scope: ScopedFilesystemScope = {
    role: "main",
    agentId: "main",
    describe: () => ({
      workspaceId: "76000000-0000-4000-8000-000000000006",
      projectId: "77000000-0000-4000-8000-000000000007",
      taskId,
      generation: 0,
      rootDirectory,
      additionalDirectories: [],
      sandboxMode: "workspace-write",
    }),
    resolvePath: async (path) => {
      const canonical = resolve(rootDirectory, path);
      if (
        canonical !== rootDirectory &&
        !canonical.startsWith(`${rootDirectory}/`)
      )
        throw new Error("夹具目录未授权");
      return canonical;
    },
  };
  const definitions = createCodeFileTools({
    backend: createScopedBackend(scope, {
      limits: {
        ...AGENT_GOVERNANCE_DEFAULTS,
        codePatchMaxBytes: truncatePreview
          ? AGENT_GOVERNANCE_LIMITS.codePatchMaxBytes.min
          : AGENT_GOVERNANCE_DEFAULTS.codePatchMaxBytes,
      },
    }),
    modelCapabilities: { image: false, pdf: false },
  });
  const read = definitions.find((entry) => entry.name === "Read");
  const edit = definitions.find((entry) => entry.name === "Edit");
  const patch = definitions.find((entry) => entry.name === "ApplyPatch");
  const mutation = multipleFiles ? patch : edit;
  if (!read || !mutation) throw new Error("缺少真实native文件工具");
  let canonicalResult: unknown;
  const capturedEdit = {
    ...mutation,
    execute: async (...args: Parameters<typeof mutation.execute>) => {
      canonicalResult = await mutation.execute(...args);
      return canonicalResult;
    },
  };
  const registry = new ToolRegistryImpl(new AgentRunEventBus());
  registry.register(read);
  registry.register(capturedEdit);
  const agent = createAgent({
    model: new FakeToolCallingModel({
      toolCalls: [
        [
          {
            id: "read-public",
            name: "Read",
            args: { file_path: "example.ts" },
          },
          ...(multipleFiles
            ? [
                {
                  id: "read-other",
                  name: "Read",
                  args: { file_path: "other.ts" },
                },
              ]
            : []),
        ],
        [
          multipleFiles
            ? {
                id: "edit-public",
                name: "ApplyPatch",
                args: {
                  patch_text:
                    "*** Begin Patch\n*** Update File: example.ts\n@@\n-first\n+second\n*** Update File: other.ts\n@@\n-left\n+right\n*** Update File: missing.ts\n@@\n-old\n+new\n*** End Patch",
                },
              }
            : {
                id: "edit-public",
                name: "Edit",
                args: {
                  file_path: "example.ts",
                  old_string: "first",
                  new_string: "second",
                  ...(truncatePreview ? { replace_all: true } : {}),
                },
              },
        ],
        [],
      ],
    }),
    tools: [
      kernelToolToStructuredTool(read),
      kernelToolToStructuredTool(capturedEdit),
    ],
    middleware: [
      createToolLifecycleMiddleware(
        {},
        {
          registry,
          resolution: {
            preset: "code",
            backendFactory: () => {
              throw new Error("公开展示不得创建backend");
            },
          },
          execution: {},
        },
      ),
    ],
  });
  const events: StreamEvent[] = [];
  const host = createCodeUiConversation({
    sessionId: taskId,
    workspacePath: rootDirectory,
    config: {
      provider: "zcode",
      model: "fixture",
      thought: "",
      followupMode: "queue",
      mode: "build",
    },
  });
  host.startTurn({ runId, commandId: "edit-fixture", text: "修改文件" });
  try {
    for await (const event of adaptDeepAgentStream({
      conversationId: taskId,
      sessionId: taskId,
      runId,
      canonicalToolEvents: true,
      stream: agent.streamEvents(
        { messages: [new HumanMessage("把first改为second")] },
        { version: "v2" },
      ),
    })) {
      events.push(event);
      host.recordEvent(event);
    }
    const snapshot = protocol.conversationSnapshotSchema.parse(
      host.getSnapshot(),
    );
    const row = snapshot.rows.window.find(
      (entry) => entry.kind === "toolCall" && entry.toolName === mutation.name,
    );
    if (!row || row.kind !== "toolCall")
      throw new Error("公开V4投影缺少真实Edit行");
    return {
      rootDirectory,
      filePath,
      row,
      events,
      canonicalResult,
      content: await readFile(filePath, "utf8"),
      ...(multipleFiles
        ? {
            otherContent: await readFile(
              join(rootDirectory, "other.ts"),
              "utf8",
            ),
          }
        : {}),
      dispose: () => rm(rootDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}
