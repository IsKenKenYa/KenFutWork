import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import { expect, it } from "vitest";
import { createHelperExecutor } from "./executor-helper.js";
import { HelperRpcError } from "./helper-client.js";
import { HelperProcessManager } from "./helper-manager.js";
import {
  createHelperPermissionRpc,
  createHelperRestartRpc,
} from "./helper-permission-rpc.js";
import { createComputerUseService } from "./service.js";

const enabled =
  process.platform === "darwin" &&
  process.env.RUN_CUA_HELPER_INTEGRATION === "1";

it.skipIf(!enabled)(
  "进程管理启动真实 Helper.app、读取状态、重启并清理 socket",
  async () => {
    const { buildHelperApp } = (await import(
      resolve(
        import.meta.dirname,
        "../../../../computer-use-helper/scripts/build-helper.mjs",
      )
    )) as {
      buildHelperApp(options: {
        out: string;
        configuration: string;
        version: string;
      }): Promise<string>;
    };
    const directory = await mkdtemp(join(tmpdir(), "kfw-helper-manager-"));
    const appPath = await buildHelperApp({
      out: join(directory, "app"),
      configuration: "dev",
      version: "0.1.0",
    });
    const socketPath = join(directory, "run", "helper.sock");
    const manager = new HelperProcessManager({ appPath, socketPath });
    try {
      const status = await manager.status();
      expect(status.available).toBe(true);
      expect((await stat(join(directory, "run"))).mode & 0o777).toBe(0o700);
      expect(status.helperBundleId).toBe("com.kenfutwork.cua-helper.dev");
      expect(status.helperPath).toBe(appPath);
      expect(["granted", "denied"]).toContain(status.accessibility);
      expect(["granted", "denied"]).toContain(status.screenRecording);

      const probed = await manager.status(true);
      expect(["granted", "stale", "denied"]).toContain(probed.accessibility);
      if (probed.accessibility === "granted")
        expect(probed.accessibilityProbeOk).not.toBe(false);
      if (probed.screenRecording === "granted")
        expect(probed.screenCaptureProbeOk).not.toBe(false);

      const applications = await manager.applications();
      expect(applications.applications.length).toBeGreaterThan(0);
      const displays = await manager.displays();
      expect(displays.displays.length).toBeGreaterThan(0);
      expect(
        displays.displays.filter((display) => display.primary),
      ).toHaveLength(1);
      const executor = createHelperExecutor({ manager });
      expect(executor.id).toBe("macos-helper");
      expect((await executor.listApps()).length).toBeGreaterThan(0);
      const previousClipboard = (await executor.readClipboard!()).text;
      try {
        const marker = `kfw-helper-${Date.now()}`;
        expect((await executor.writeClipboard!(marker)).written).toBe(true);
        expect((await executor.readClipboard!()).text).toBe(marker);
      } finally {
        await executor.writeClipboard!(previousClipboard);
      }
      const finder = applications.applications.find(
        (application) => application.bundleId === "com.apple.finder",
      );
      if (finder) {
        const rows = await executor.listWindows({ pid: finder.pid });
        expect(rows.every((row) => typeof row.windowId === "number")).toBe(
          true,
        );
        const raster = await executor.capture(
          { pid: finder.pid },
          {
            signal: AbortSignal.timeout(10_000),
            maxOutputBytes: 67_108_864,
          },
        );
        expect(raster.base64.length).toBeGreaterThan(0);
        expect(raster.width).toBeGreaterThan(0);

        const service = createComputerUseService({
          executor,
          governance: () => ({
            actionTimeoutMs:
              AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs,
            observeMaxBytes:
              AGENT_GOVERNANCE_DEFAULTS.computerUseObserveMaxBytes,
            screenshotMaxBytes: 262_144,
            maxActionsPerRun:
              AGENT_GOVERNANCE_DEFAULTS.computerUseMaxActionsPerRun,
            sessionMaxMs: AGENT_GOVERNANCE_DEFAULTS.computerUseSessionMaxMs,
            axMaxDepth: AGENT_GOVERNANCE_DEFAULTS.computerUseAxMaxDepth,
            axMaxChildren: AGENT_GOVERNANCE_DEFAULTS.computerUseAxMaxChildren,
            axTitleMaxChars:
              AGENT_GOVERNANCE_DEFAULTS.computerUseAxTitleMaxChars,
            axValueMaxChars:
              AGENT_GOVERNANCE_DEFAULTS.computerUseAxValueMaxChars,
            axMaxActions: AGENT_GOVERNANCE_DEFAULTS.computerUseAxMaxActions,
            inputDelayMs: AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs,
            processMaxOutputBytes:
              AGENT_GOVERNANCE_DEFAULTS.processMaxOutputBytes,
          }),
        });
        const screenshot = await service.screenshot({ pid: finder.pid });
        expect(screenshot.content[0]).toMatchObject({ type: "text" });
        expect((screenshot.content[0] as { text: string }).text).toContain(
          "已截取",
        );
        try {
          const observation = await executor.observe({ pid: finder.pid });
          expect(observation.root.role).toBe("application");
          expect(observation.app.pid).toBe(finder.pid);
        } catch (error) {
          expect((error as { code?: string }).code).toBe("permission_denied");
        }
      }
      if (finder) {
        const windows = await manager.windows(finder.pid);
        expect(
          windows.windows.every((window) => window.pid === finder.pid),
        ).toBe(true);
        try {
          const tree = await manager.axTree({
            pid: finder.pid,
            maxDepth: 2,
            maxNodes: 20,
          });
          expect(tree.nodeCount).toBeGreaterThan(0);
          expect(tree.nodeCount).toBeLessThanOrEqual(20);
        } catch (error) {
          expect((error as { code?: string }).code).toBe("permission_denied");
        }
        const visible = windows.windows.find((window) => window.onScreen);
        if (visible) {
          try {
            const shot = await manager.screenshot({
              pid: finder.pid,
              windowId: visible.windowId,
              maxDimension: 320,
            });
            expect(shot.windowId).toBe(visible.windowId);
            expect(
              Buffer.from(shot.imageBase64, "base64").length,
            ).toBeGreaterThan(0);
            expect(typeof shot.blackFrame).toBe("boolean");
          } catch (error) {
            expect(error).toBeInstanceOf(HelperRpcError);
            expect((error as HelperRpcError).code).toBe("permission_denied");
          }
        }
      }

      const restarted = await manager.restart();
      expect(restarted.ok).toBe(true);
      const afterRestart = await manager.status();
      expect(afterRestart.helperBundleId).toBe("com.kenfutwork.cua-helper.dev");

      const helper = () => ({ available: true as const, manager });
      const gate = async () => ({ ok: true as const });
      const context = {} as never;
      const actor = {} as never;
      const webStatus = (await createHelperPermissionRpc({ gate, helper }).call(
        actor,
        ["/workspace"],
        context,
      )) as Record<string, unknown>;
      expect(webStatus.available).toBe(true);
      expect(webStatus.grantOwner).toBe(appPath);
      expect(webStatus.grantOwnerDisplayName).toBe(
        "KenFutWork Computer Use Dev",
      );
      expect(["granted", "denied", "unknown"]).toContain(
        webStatus.accessibility,
      );
      const probedWebStatus = (await createHelperPermissionRpc({
        gate,
        helper,
      }).call(
        actor,
        ["/workspace", undefined, { includeFunctionalProbes: true }],
        context,
      )) as Record<string, unknown>;
      expect(probedWebStatus.accessibilityProbeOk).toBe(
        probed.accessibilityProbeOk,
      );

      expect(
        await createHelperRestartRpc({ gate, helper }).call(
          actor,
          ["/workspace"],
          context,
        ),
      ).toEqual({ ok: true });

      await manager.stop();
      await expect(access(socketPath)).rejects.toThrow();
    } finally {
      await manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
