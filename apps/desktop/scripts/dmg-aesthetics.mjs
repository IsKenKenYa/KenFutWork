/**
 * DMG 背景与图标布局的**产物级**判据。
 *
 * 为什么不能问引擎：bundle_dmg.sh 在无 GUI 会话里必须带 `--skip-jenkins`，而该开关的行为
 * 就是跳过「让 Finder 写卷根 .DS_Store」的 AppleScript——脚本自己打印
 * 「This will result in a DMG without any custom background or icons positioning」，
 * 却仍然**退出 0**。托管 runner 实测产物正是白底默认排布，而当时的日志与清单都写着
 * 「布局引擎=bundle_dmg」。所以「用了哪档引擎」不是证据，挂载后读 .DS_Store 才是。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 只读取证：挂载只读 → 查 .DS_Store 的背景引用 → 卸载。失败原因写人话。 */
export function verifyDmgAesthetics(
  dmgPath,
  { hdiutil = "/usr/bin/hdiutil" } = {},
) {
  const mount = mkdtempSync(join(tmpdir(), "kfw-dmg-verify-"));
  try {
    const attach = spawnSync(
      hdiutil,
      ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmgPath],
      { encoding: "utf8" },
    );
    if (attach.status !== 0) {
      const detail = `${attach.stderr ?? ""}${attach.stdout ?? ""}`.trim();
      return {
        ok: false,
        why: `DMG 挂不上（无法取证）：${detail || `退出码 ${attach.status}`}`,
      };
    }
    const storePath = join(mount, ".DS_Store");
    if (!existsSync(storePath)) {
      return {
        ok: false,
        why: "卷根没有 .DS_Store，Finder 打开就是默认白底排布",
      };
    }
    const store = readFileSync(storePath);
    if (!store.includes("backgroundImageAlias")) {
      return {
        ok: false,
        why: ".DS_Store 里没有 backgroundImageAlias，背景图没有被引用",
      };
    }
    if (!existsSync(join(mount, ".background", "background.png"))) {
      return {
        ok: false,
        why: "背景图被引用但 .background/background.png 不在卷内",
      };
    }
    return { ok: true, why: null };
  } finally {
    spawnSync(hdiutil, ["detach", "-force", mount], { encoding: "utf8" });
    rmSync(mount, { recursive: true, force: true });
  }
}
