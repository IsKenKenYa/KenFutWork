import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 入口资源根目录（`pg/`、`supabase/`、`runtime/`、`tmp/` 等资源相对它定位）。
 *
 * 两种形态：
 * - **源码态（dev / 自托管源码）**：入口文件是 `<仓库根>/apps/server/{src|dist}/server.js`，
 *   故上**四级**到仓库根（src → server → apps → 仓库根）。原来错上三级，得到的是 `apps/`，
 *   于是沙箱落到 `apps/tmp/sandbox`、随包运行时去 `apps/runtime` 找（实际在仓库根），
 *   两处都错——用户要求「沙箱放项目根或 exe 目录下的 tmp/sandbox」正是为了消除这种漂移。
 * - **打包态（Node SEA）**：`import.meta.url` 为空，回退到可执行文件所在目录。
 */
export function resolveEntryRoot(input: {
  entryFileUrl: string | undefined;
  execPath: string;
}): string {
  if (input.entryFileUrl) {
    try {
      return dirname(dirname(dirname(dirname(fileURLToPath(input.entryFileUrl)))));
    } catch {
      // 非法 file URL 与 SEA 的空值同样处理：落到 exe 目录
    }
  }
  return dirname(input.execPath);
}
