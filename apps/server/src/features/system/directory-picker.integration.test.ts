import { describe, expect, it } from "vitest";

import { nativePickerCommands, runPickerCommand } from "./directory-picker.js";

/**
 * 原生目录对话框的**真机**验收（默认 skipped，会弹一个真窗口，不能进常规测试）：
 *
 *   KENFUTWORK_NATIVE_DIALOG_IT=1 pnpm --filter @kenfutwork/server exec vitest run directory-picker.integration
 *
 * 单测只能验命令形状与结果翻译；「PowerShell 脚本没有语法错、WinForms 装配得上、
 * 对话框真弹出来了」只有真跑一次才作数。判据是**反证**：脚本要是错了会立刻以非 0
 * 退出并带 stderr，而它一直活到超时（stderr 为空）正好说明对话框开着等人点。
 */
const ENABLED = process.env.KENFUTWORK_NATIVE_DIALOG_IT === "1";

describe.skipIf(!ENABLED || process.platform !== "win32")(
  "原生目录对话框（真机）",
  () => {
    it("Windows：对话框进程起得来、stderr 为空、超时才被收掉", async () => {
      const [command] = nativePickerCommands("win32");
      if (!command) throw new Error("win32 没有候选命令");

      const outcome = await runPickerCommand(command, 6000);

      expect(outcome.stderr.trim()).toBe("");
      expect(outcome.stdout).toBe("");
      // 一直活到超时 = 对话框在等人点（脚本错误会在毫秒级退出）
      expect(outcome.timedOut).toBe(true);
      expect(outcome.code).toBeNull();
    }, 20_000);
  },
);
