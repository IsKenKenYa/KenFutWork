import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProcessSandboxError } from "./types.js";

/** 保留上游许可证；只修 Task 私有 node-pty 1.1.0 副本，不写安装包。 */
export async function patchTaskPtyTail(moduleDirectory: string): Promise<void> {
  const path = join(moduleDirectory, "lib", "unixTerminal.js");
  const source = await readFile(path, "utf8");
  const nativeExit = "var onexit = function (code, signal) {";
  const destroy = "_this._socket.destroy();";
  if (
    source.split(nativeExit).length !== 2 ||
    source.split(destroy).length !== 2
  )
    throw new ProcessSandboxError(
      "enforcement_unavailable",
      "node-pty native close 结构改变，不能确认尾部读尽适配。",
    );
  // 上游已经把进程退出与 socket close 分开；暴露内部 reaper 事实给本 adapter。
  const patched = source
    .replace(
      nativeExit,
      `${nativeExit}\n            _this.emit("__kfwNativeExit", code, signal);`,
    )
    .replace(
      destroy,
      "if (!_this.__kfwHoldExitWhilePaused || !_this._socket.isPaused()) _this._socket.destroy();",
    );
  await writeFile(path, patched);
}
