import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  instanceSettingsResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { type Host, waitPhase } from "./history-fork.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const readGit = promisify(execFile);
const repositoryRoot = fileURLToPath(
  new URL("../../../../../", import.meta.url),
);

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Task 自动提交的真实 Git 归属 integration",
  () => {
    it("完全访问 Run 只把 Task 文件提交到自己的临时仓库，主仓 HEAD 保持不变", async () => {
      const fixture = await createCodeUiHttpFixture();
      let host: Host | undefined;
      let model: Awaited<ReturnType<typeof heldModel>> | undefined;
      try {
        model = await heldModel();
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
          initialConfig: { mode: "yolo", planEnabled: false },
        });
        const workspace = await realpath(host.workspacePath);
        const ownRoot = await readGit("git", ["rev-parse", "--show-toplevel"], {
          cwd: workspace,
        });
        // 发送前确认隔离已经成立；本用例不在主仓重演自动提交。
        expect(await realpath(ownRoot.stdout.trim())).toBe(workspace);
        const initial = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(initial.config).toMatchObject({
          mode: "yolo",
          planEnabled: false,
        });
        const settings = await host.client.request("/api/instance/settings");
        expect(settings.status, JSON.stringify(settings.body)).toBe(200);
        expect(
          instanceSettingsResponseSchema.parse(settings.body).settings
            .codeAutoCommitEnabled,
        ).toBe(true);
        const before = await readGit("git", ["rev-parse", "HEAD"], {
          cwd: repositoryRoot,
        });
        const fileName = `task-git-sentinel-${randomUUID()}.txt`;
        const content = Buffer.from("TASK_GIT_ISOLATION_完整字节\n", "utf8");
        await writeFile(join(workspace, fileName), content, { flag: "wx" });
        const sent = await host.command("sendText", {
          text: "CONFIRM_TASK_GIT_ISOLATION",
        });
        expect(sent.status, JSON.stringify(sent.body)).toBe(200);
        expect(protocol.commandAckSchema.parse(sent.body.result).status).toBe(
          "accepted",
        );
        const activeModel = model;
        // 独占 HTTP、PG、沙箱和 Git 的同步期限，不定义产品运行限额。
        await vi.waitFor(() => expect(activeModel.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        expect(activeModel.requests[0]?.body).toMatchObject({
          model: "stop-model",
          stream: true,
        });
        activeModel.finish(0);
        await waitPhase(fixture, host.sessionId, "completedSuccess");
        await vi.waitFor(
          async () => {
            const committed = await readGit(
              "git",
              ["show", `HEAD:${fileName}`],
              {
                cwd: workspace,
                encoding: "buffer",
              },
            );
            expect(committed.stdout).toEqual(content);
          },
          { timeout: 30_000 },
        );
        const after = await readGit("git", ["rev-parse", "HEAD"], {
          cwd: repositoryRoot,
        });
        expect(after.stdout.trim()).toBe(before.stdout.trim());
      } finally {
        try {
          await host?.dispose();
        } finally {
          try {
            await model?.close();
          } finally {
            await fixture.close();
          }
        }
      }
    }, 120_000);
  },
);
