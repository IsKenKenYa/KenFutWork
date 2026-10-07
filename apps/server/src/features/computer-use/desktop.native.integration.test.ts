import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { kernelToolToStructuredTool } from "../../agent/kernel-tools-bridge.js";
import { AgentRunEventBus, ToolRegistryImpl } from "../../kernel/context.js";
import { createMacosExecutor } from "./executor-macos.js";
import { runJxa } from "./jxa.js";
import { withMacosClipboardText } from "./macos-clipboard.js";
import { createComputerUseMcpServer } from "./mcp-server.js";
import { createComputerUseService } from "./service.js";
import { createComputerUseTools } from "./tools.js";

const exec = promisify(execFile);
const defaults = AGENT_GOVERNANCE_DEFAULTS;
const enabled =
  process.env.KENFUTWORK_TEST_DESKTOP === "1" && process.platform === "darwin";

describe.skipIf(!enabled).each(["源码", "打包"])(
  "真实macOS%s窗口→Harness→MCP公共协议",
  (form) => {
    it("Unicode剪贴板跨进程可读且正常/取消后恢复各格式", async () => {
      const digest = async () => {
        const snapshot = await runJxa(
          `ObjC.import('AppKit'); const rows=[], items=$.NSPasteboard.generalPasteboard.pasteboardItems;
for(let i=0;i<Number(items.count);i++) {
  const item=items.objectAtIndex(i), types=item.types, row=[];
  for(let j=0;j<Number(types.count);j++) {
    const type=types.objectAtIndex(j), data=item.dataForType(type);
    row.push([ObjC.unwrap(type),ObjC.unwrap(data.base64EncodedStringWithOptions(0))]);
  }
  rows.push(row);
}
JSON.stringify(rows);`,
          defaults.computerUseActionTimeoutMs,
        );
        return createHash("sha256")
          .update(JSON.stringify(snapshot))
          .digest("hex");
      };
      const before = await digest();
      const controller = new AbortController();
      const context = { signal: controller.signal };
      const read = () =>
        runJxa(
          `ObjC.import('AppKit'); JSON.stringify({text:ObjC.unwrap($.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString))});`,
          defaults.computerUseActionTimeoutMs,
        );
      expect(
        await withMacosClipboardText(
          "中文🙂🚀",
          context,
          defaults.computerUseActionTimeoutMs,
          read,
        ),
      ).toEqual({ text: "中文🙂🚀" });
      expect(await digest()).toBe(before);
      await expect(
        withMacosClipboardText(
          "取消验收",
          context,
          defaults.computerUseActionTimeoutMs,
          async () => {
            expect(await read()).toEqual({ text: "取消验收" });
            controller.abort();
            controller.signal.throwIfAborted();
          },
        ),
      ).rejects.toThrow();
      expect(await digest()).toBe(before);
    });
    it(
      "发现、2x截图、语义点击、坐标点击、键盘与跨Run拒绝",
      async () => {
        const directory = await mkdtemp(join(tmpdir(), "kenfutwork-cu-test-"));
        let fixture: ReturnType<typeof spawn> | undefined;
        let testShiftHeld = false;
        let executor = createMacosExecutor();
        if (form === "打包") {
          const release = join(directory, "release");
          await exec(process.execPath, [
            new URL("./build-helper.mjs", import.meta.url).pathname,
            join(release, "computer-use"),
          ]);
          const bundle = join(release, "server", "desktop-probe.cjs");
          await exec("pnpm", [
            "exec",
            "esbuild",
            new URL("./executor-macos.ts", import.meta.url).pathname,
            "--bundle",
            "--platform=node",
            "--format=cjs",
            "--define:import.meta.url=__filename",
            "--define:KFW_PACKAGED_CJS=true",
            "--external:@computer-use/node-mac-permissions",
            `--outfile=${bundle}`,
          ]);
          const bundled = createRequire(import.meta.url)(bundle) as {
            createMacosExecutor: typeof createMacosExecutor;
          };
          executor = bundled.createMacosExecutor();
        }
        let inputDelayMs: number = defaults.computerUseInputDelayMs;
        const service = createComputerUseService({
          executor,
          governance: () => ({
            actionTimeoutMs: defaults.computerUseActionTimeoutMs,
            observeMaxBytes: defaults.computerUseObserveMaxBytes,
            screenshotMaxBytes: defaults.computerUseScreenshotMaxBytes,
            maxActionsPerRun: defaults.computerUseMaxActionsPerRun,
            sessionMaxMs: defaults.computerUseSessionMaxMs,
            inputDelayMs,
          }),
        });
        const registry = new ToolRegistryImpl(new AgentRunEventBus());
        // 本测试以已授权的安装消费者配置直接装配真实工具，不替换service/executor/OS。
        for (const tool of createComputerUseTools({
          service,
          gate: async () => ({ ok: true }),
        }))
          registry.register(tool);
        const server = createComputerUseMcpServer({
          registry,
          version: "test",
          resolveContext: async () => ({ runId: "desktop-native-test" }),
        });
        const client = new Client({
          name: "desktop-native-test",
          version: "test",
        });
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        try {
          const executable = join(directory, "desktop-probe");
          await exec("swiftc", [
            "-module-cache-path",
            join(tmpdir(), "kenfutwork-swift-module-cache"),
            new URL("./fixtures/desktop.swift", import.meta.url).pathname,
            "-o",
            executable,
          ]);
          fixture = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
          let events = "";
          fixture.stdout!.on("data", (data) => {
            events += String(data);
          });
          await once(fixture.stdout!, "data");
          const app = { pid: fixture.pid! };
          await server.connect(serverTransport);
          await client.connect(clientTransport);
          const call = async (
            name: string,
            args: Record<string, unknown> = {},
          ) => {
            const result = (await client.callTool({
              name,
              arguments: args,
            })) as {
              isError?: boolean;
              content: Array<{ type: string; text?: string }>;
              structuredContent?: Record<string, unknown>;
            };
            expect(result.isError, JSON.stringify(result.content)).not.toBe(
              true,
            );
            return result;
          };
          expect(
            (await client.listTools()).tools.some(
              (tool) => tool.name === "drag",
            ),
          ).toBe(true);
          const access = await call("request_access");
          expect(
            (
              access.structuredContent!.permissionStatus as Record<
                string,
                string
              >
            ).postEvents,
          ).toBe("granted");
          const apps = await call("list_apps");
          expect(
            (apps.structuredContent!.apps as Array<{ pid: number }>).some(
              (row) => row.pid === app.pid,
            ),
          ).toBe(true);
          const displays = await call("list_displays");
          expect(
            (displays.structuredContent!.displays as unknown[]).length,
          ).toBeGreaterThan(0);
          await expect
            .poll(
              async () => {
                const result = await client.callTool({
                  name: "list_windows",
                  arguments: { app },
                });
                const structured = result.structuredContent;
                const windows =
                  structured &&
                  typeof structured === "object" &&
                  "windows" in structured
                    ? structured.windows
                    : undefined;
                return Array.isArray(windows) ? windows.length : 0;
              },
              {
                timeout: defaults.computerUseActionTimeoutMs,
                interval: defaults.computerUseInputDelayMs,
              },
            )
            .toBeGreaterThan(0);
          const windows = await call("list_windows", { app });
          expect(JSON.stringify(windows.structuredContent)).toContain(
            "KenFutWork 桌面能力验收",
          );
          const state = await call("get_app_state", {
            app,
            include_screenshot: true,
          });
          const tree = state.content.find((block) => block.type === "text")!
            .text!;
          const index = Number(tree.match(/\[(\d+)\] button 验收按钮/)?.[1]);
          expect(Number.isInteger(index), tree).toBe(true);
          await call("click", { app, target: { type: "element", index } });
          expect(
            JSON.stringify((await call("get_app_state", { app })).content),
          ).toContain("点击数：1");
          const shot = await call("screenshot", { app });
          const image = shot.structuredContent!.image as {
            width: number;
            height: number;
            frameId: string;
            bounds: number[];
          };
          expect(image).not.toHaveProperty("data");
          const imageBlock = shot.content.find(
            (block) => block.type === "image",
          ) as unknown as { data: string };
          await writeFile(
            "/tmp/kenfutwork-cu-fixture.png",
            Buffer.from(imageBlock.data, "base64"),
          );
          expect(image.width).toBeGreaterThan(0);
          const target = {
            type: "coordinate",
            x: image.width * 0.25,
            y: image.height * 0.32,
            frameId: image.frameId,
          };
          const clicked = await call("click", { app, target });
          expect(
            JSON.stringify((await call("get_app_state", { app })).content),
            JSON.stringify({
              size: [image.width, image.height],
              bounds: image.bounds,
              events,
              target,
              clicked: clicked.content,
            }),
          ).toContain("点击数：2");
          const screenshotName = "mcp__computer-use__screenshot";
          const modelTool = kernelToolToStructuredTool(
            {
              ...registry.require(screenshotName),
              execute: (args, context) =>
                registry.execute(screenshotName, args, context),
            },
            { runId: "desktop-native-test" },
          );
          const modelImage = await modelTool.invoke({
            type: "tool_call",
            name: screenshotName,
            id: "macos-model-image-proof",
            args: { app },
          });
          const modelContent = (modelImage as { content: unknown }).content;
          const modelBlocks = Array.isArray(modelContent)
            ? modelContent.map((block: Record<string, unknown>) => ({
                type: block.type,
                source_type: block.source_type,
                mime_type: block.mime_type,
                hasData:
                  typeof block.data === "string" && block.data.length > 0,
              }))
            : { contentType: typeof modelContent };
          expect(modelBlocks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "image",
                source_type: "base64",
                mime_type: "image/png",
                hasData: true,
              }),
            ]),
          );
          const current = await call("screenshot", { app });
          const frame = current.structuredContent!.image as typeof image;
          const blank = {
            type: "coordinate",
            x: frame.width * 0.8,
            y: frame.height * 0.5,
            frameId: frame.frameId,
          };
          await call("click", { app, target: blank });
          await call("mouse_move", {
            app,
            target: { ...blank, x: frame.width * 0.7 },
          });
          await call("key", { app, keys: ["A"] });
          await call("scroll", {
            app,
            target: blank,
            direction: "down",
            amount: 2,
          });
          await call("drag", {
            app,
            from: blank,
            to: { ...blank, x: frame.width * 0.6 },
          });
          expect(events).toContain("EVENT move");
          expect(events).toContain("EVENT key");
          expect(events).toContain("EVENT scroll");
          expect(events).toContain("EVENT drag");
          const inputState = await call("get_app_state", { app });
          const inputTree = inputState.content.find(
            (block) => block.type === "text",
          )!.text!;
          const inputIndex = Number(
            inputTree.match(/\[(\d+)\] textfield 验收输入/)?.[1],
          );
          expect(Number.isInteger(inputIndex), inputTree).toBe(true);
          await call("type", {
            app,
            text: "中文🙂🚀",
            target: { type: "element", index: inputIndex },
          });
          expect(
            JSON.stringify((await call("get_app_state", { app })).content),
            JSON.stringify({
              keyEvents: events
                .split("\n")
                .filter((line) => /^(KEY|SHIFT)/.test(line)),
            }),
          ).toContain("中文🙂🚀");
          const mainWindowId = (
            inputState.structuredContent!.window as { window_id: number }
          ).window_id;
          expect(mainWindowId).toBeGreaterThan(0);
          const afterInput = events.length;
          const interrupted = new AbortController();
          inputDelayMs = defaults.computerUseInputDelayMs * 10;
          const pending = registry
            .execute(
              "mcp__computer-use__key",
              { app, keys: ["shift", "A"] },
              { runId: "desktop-native-test", signal: interrupted.signal },
            )
            .then(
              (result) => ({ result, error: undefined }),
              (error: unknown) => ({ result: undefined, error }),
            );
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              fixture!.stdout!.off("data", check);
              reject(new Error("真实Shift按下事件未到达验收窗口"));
            }, defaults.computerUseActionTimeoutMs);
            const check = () => {
              if (events.slice(afterInput).includes("SHIFT 1")) {
                clearTimeout(timer);
                fixture!.stdout!.off("data", check);
                resolve();
              }
            };
            fixture!.stdout!.on("data", check);
            check();
          });
          testShiftHeld = true;
          const inputWorkers = (
            await exec("pgrep", [
              "-P",
              String(process.pid),
              "-f",
              "input-worker",
            ])
          ).stdout
            .trim()
            .split("\n")
            .map(Number);
          expect(inputWorkers).toHaveLength(1);
          // 冻结我们自己的原生子进程，真实覆盖SIGTERM无响应→强制退出→独立释放。
          process.kill(inputWorkers[0]!, "SIGSTOP");
          interrupted.abort();
          const aborted = await pending;
          expect(
            aborted.error !== undefined ||
              (aborted.result as { isError?: boolean })?.isError === true,
          ).toBe(true);
          await call("stop_computer_control");
          const stoppedFrame = await client.callTool({
            name: "click",
            arguments: { app, target: blank },
          });
          expect(stoppedFrame.isError).toBe(true);
          expect(JSON.stringify(stoppedFrame.structuredContent)).toContain(
            "element_stale",
          );
          inputDelayMs = defaults.computerUseInputDelayMs;
          const released = await exec("osascript", [
            "-l",
            "JavaScript",
            "-e",
            "ObjC.import('CoreGraphics'); JSON.stringify({shiftDown: Boolean(Number($.CGEventSourceFlagsState(0)) & 131072)});",
          ]);
          expect(JSON.parse(released.stdout).shiftDown).toBe(false);
          testShiftHeld = false;
          expect(events.slice(afterInput)).toContain("SHIFT 0");
          const command = async (name: string) => {
            const observed = new Promise<void>((resolve) => {
              const read = (data: Buffer) => {
                if (String(data).includes(`COMMAND ${name}`)) {
                  fixture!.stdout!.off("data", read);
                  resolve();
                }
              };
              fixture!.stdout!.on("data", read);
            });
            fixture!.stdin!.write(`${name}\n`);
            await observed;
          };
          const beforeReorder = await call("screenshot", { app });
          await command("second");
          await call("click", {
            app,
            target: {
              ...target,
              frameId: (beforeReorder.structuredContent!.image as typeof image)
                .frameId,
            },
          });
          const reordered = await call("list_windows", { app });
          expect(JSON.stringify(reordered.structuredContent)).toContain(
            "KenFutWork 第二窗口",
          );
          const main = { pid: app.pid, windowId: mainWindowId };
          const pinned = await call("get_app_state", { app: main });
          expect(JSON.stringify(pinned.structuredContent)).toContain(
            "KenFutWork 桌面能力验收",
          );
          expect(JSON.stringify(pinned.content)).toContain("中文🙂🚀");
          expect(JSON.stringify(pinned.content)).toContain("点击数：3");
          const secondId = (
            reordered.structuredContent!.windows as Array<{
              windowId: number;
              title: string;
            }>
          ).find((row) => row.title === "KenFutWork 第二窗口")!.windowId;
          expect(secondId).not.toBe(mainWindowId);
          const second = await call("get_app_state", {
            app: { pid: app.pid, windowId: secondId },
          });
          expect(JSON.stringify(second.content)).toContain("点击数：0");
          const buttonIndex = Number(
            JSON.stringify(pinned.content).match(
              /\[(\d+)\] button 验收按钮/,
            )?.[1],
          );
          expect(Number.isInteger(buttonIndex)).toBe(true);
          await command("rename-main-button");
          const staleElement = await client.callTool({
            name: "click",
            arguments: {
              app: main,
              target: { type: "element", index: buttonIndex },
            },
          });
          expect(staleElement.isError).toBe(true);
          expect(staleElement.structuredContent).toMatchObject({
            error: { code: "element_stale", actionSent: false },
          });
          const renamed = await call("get_app_state", { app: main });
          expect(JSON.stringify(renamed.content)).toContain("点击数：3");
          expect(JSON.stringify(renamed.content)).toContain("变更后的按钮");
          await call("click", {
            app: main,
            target: { type: "element", index: buttonIndex },
          });
          expect(
            JSON.stringify(
              (await call("get_app_state", { app: main })).content,
            ),
          ).toContain("点击数：4");
          await command("close-main");
          const closed = await client.callTool({
            name: "key",
            arguments: { app: main, keys: ["A"] },
          });
          expect(closed.isError).toBe(true);
          expect(JSON.stringify(closed.structuredContent)).toContain(
            "element_stale",
          );
          expect(JSON.stringify(closed.structuredContent)).toContain(
            '"actionSent":false',
          );
          const foreign = (await registry.execute(
            "mcp__computer-use__click",
            { app, target },
            { runId: "another-run" },
          )) as { isError?: boolean };
          expect(foreign.isError).toBe(true);
          const cancelled = new AbortController();
          cancelled.abort();
          await expect(
            registry.execute(
              "mcp__computer-use__screenshot",
              { app },
              { runId: "desktop-native-test", signal: cancelled.signal },
            ),
          ).rejects.toThrow();
          await call("stop_computer_control");
        } finally {
          if (testShiftHeld)
            await exec("osascript", [
              "-l",
              "JavaScript",
              "-e",
              "ObjC.import('CoreGraphics'); const e=$.CGEventCreateKeyboardEvent(null,56,false); $.CGEventSetFlags(e,0); $.CGEventPost(0,e);",
            ]);
          await client.close();
          await server.close();
          await service.dispose();
          if (fixture && fixture.exitCode === null) {
            fixture.kill();
            await once(fixture, "exit");
          }
          await rm(directory, { recursive: true, force: true });
        }
      },
      defaults.computerUseSessionMaxMs,
    );
  },
);
