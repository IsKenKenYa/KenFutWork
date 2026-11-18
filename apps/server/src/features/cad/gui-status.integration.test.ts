import { realpath } from "node:fs/promises";
import { expect, it } from "vitest";
import { z } from "zod";
import { cadGuiApplicationSchema } from "./gui-document-contracts.js";
import { createMacosCadGuiProbe } from "./gui-probe.js";
import { executeCadTestTool, withNativeCad } from "./test-fixtures.js";
import { createCadTools } from "./tools.js";

it.skipIf(process.env.KENFUTWORK_CAD_GUI_INTEGRATION !== "1")(
  "真实 macOS Task 工具查询 FreeCAD GUI 并复核实际安装和启动身份",
  async () => {
    await withNativeCad(async ({ service, context }) => {
      const tool = createCadTools(service).find(
        (item) => item.name === "cad_gui_status",
      );
      if (!tool) throw new Error("缺少 FreeCAD 应用查询工具");
      const result = await executeCadTestTool(tool, {}, context);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const { applications, currentDocumentControl } = z
        .object({
          applications: z.array(cadGuiApplicationSchema),
          currentDocumentControl: z.literal(false),
        })
        .parse(result.structuredContent);
      expect(currentDocumentControl).toBe(false);
      // 显式启用的原生验收要求已打开应用，空列表不能冒充真实绑定通过。
      expect(applications.length).toBeGreaterThan(0);
      const probe = createMacosCadGuiProbe();
      for (const application of applications) {
        expect(await realpath(application.executablePath)).toBe(
          application.executablePath,
        );
        expect(await realpath(application.bundlePath)).toBe(
          application.bundlePath,
        );
        expect(
          await probe.verify(application, {
            ...(context.signal ? { signal: context.signal } : {}),
            timeoutMs: 10_000,
            maxOutputBytes: 65_536,
          }),
        ).toEqual(application);
      }
    });
  },
  30_000,
);
