import { dirname } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

/**
 * mac 打包形态标记：由 package-mac.mjs 的 esbuild `--define:KFW_PACKAGED_CJS=true`
 * 注入（dev/tsx 与 Windows SEA 下均未定义）。
 */
declare const KFW_PACKAGED_CJS: boolean | undefined;

/**
 * mac 打包（CJS 入口）的资源根：server.cjs 位于 `<exeDir>/server/`，资源根是其父目录。
 * 独立导出便于单测（KFW_PACKAGED_CJS 是编译期常量，测试进不去那个分支）。
 */
export function resolveEntryRootForPackagedCjs(entryFilePath: string): string {
  return dirname(dirname(entryFilePath));
}

/**
 * 入口资源根目录（`pg/`、`supabase/`、`runtime/`、`tmp/` 等资源相对它定位）。
 *
 * 三种形态：
 * - **源码态（dev / 自托管源码）**：入口文件是 `<仓库根>/apps/server/{src|dist}/server.js`，
 *   故上**四级**到仓库根（src → server → apps → 仓库根）。原来错上三级，得到的是 `apps/`，
 *   于是沙箱落到 `apps/tmp/sandbox`、随包运行时去 `apps/runtime` 找（实际在仓库根），
 *   两处都错——用户要求「沙箱放项目根或 exe 目录下的 tmp/sandbox」正是为了消除这种漂移。
 * - **mac 打包（CJS + 随包 node）**：esbuild 把 import.meta.url 定义成 __filename
 *   （`<app>/server/server.cjs`），KFW_PACKAGED_CJS 已定义 → 上**两级**到 `<app>`。
 * - **Windows 打包（Node SEA）**：banner 给了 `<exe>/server.cjs` 形式的 import.meta.url，
 *   但资源根是 exe 所在目录（`node:sea` 的 isSea() 判定），不走源码层级上四级。
 */
export function resolveEntryRoot(input: {
  entryFileUrl: string | undefined;
  execPath: string;
  /** 是否 Node SEA 单文件宿主；缺省用 node:sea 自检（测试可显式注入）。 */
  sea?: boolean;
}): string {
  // Windows SEA：打包 banner 把 import.meta.url 定义成 <exe>/server.cjs（外部原生包
  // 要从发布目录解析），但资源根**不是**按源码层级上四级——它就是 exe 所在目录。
  // 漏了这条会走下面的「上四级」分支，实测得到 D:\a\supabase 这种不存在的根，
  // 迁移目录/随包运行时全找不到。
  if (input.sea ?? isSea()) {
    return dirname(input.execPath);
  }
  if (typeof KFW_PACKAGED_CJS !== "undefined" && KFW_PACKAGED_CJS) {
    // esbuild 的 define 把 import.meta.url 换成了 __filename（纯路径，非 file:// URL）
    if (input.entryFileUrl) {
      return resolveEntryRootForPackagedCjs(input.entryFileUrl);
    }
  }
  if (input.entryFileUrl) {
    try {
      return dirname(
        dirname(dirname(dirname(fileURLToPath(input.entryFileUrl)))),
      );
    } catch {
      // 非法 file URL 与 SEA 的空值同样处理：落到 exe 目录
    }
  }
  return dirname(input.execPath);
}
