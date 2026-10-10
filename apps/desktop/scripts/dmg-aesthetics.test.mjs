/**
 * `verifyDmgAesthetics` 的夹具测试：用假的 hdiutil 把「卷内容」目录映射到挂载点，
 * 这样四条判据（没有 .DS_Store / 有但不引用背景 / 引用了但图不在 / 齐全）都能在
 * 任何平台上跑，不依赖真实出包产物，也不真的挂载镜像。
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyDmgAesthetics } from "./dmg-aesthetics.mjs";

const BACKGROUND_KEY = "backgroundImageAlias";

/** @param {(volume: string) => void} build 往「卷根」里摆夹具内容 */
function fixture(build) {
  const root = mkdtempSync(join(tmpdir(), "kfw-dmg-fixture-"));
  const volume = join(root, "volume");
  mkdirSync(volume, { recursive: true });
  build(volume);
  const calls = join(root, "calls.log");
  const hdiutil = join(root, "hdiutil");
  writeFileSync(
    hdiutil,
    `#!/bin/sh
echo "$1" >> "${calls}"
if [ "$1" = "attach" ]; then
  shift
  mount=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "-mountpoint" ]; then mount="$2"; shift 2; else shift; fi
  done
  cp -R "${volume}/." "$mount/"
  exit 0
fi
exit 0
`,
  );
  chmodSync(hdiutil, 0o755);
  const dmg = join(root, "sample.dmg");
  writeFileSync(dmg, "夹具镜像");
  return {
    calls,
    dmg,
    hdiutil,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withBackground(volume) {
  writeFileSync(join(volume, ".DS_Store"), `WindowBounds${BACKGROUND_KEY}`);
  mkdirSync(join(volume, ".background"), { recursive: true });
  writeFileSync(join(volume, ".background", "background.png"), "png");
}

test("DMG 取证：卷根没有 .DS_Store 时判「无背景布局」并说清后果", () => {
  const f = fixture(() => {});
  try {
    const verdict = verifyDmgAesthetics(f.dmg, { hdiutil: f.hdiutil });
    assert.equal(verdict.ok, false);
    assert.match(verdict.why, /没有 \.DS_Store/u);
  } finally {
    f.cleanup();
  }
});

test("DMG 取证：有 .DS_Store 但不引用背景图时按「背景没生效」判", () => {
  const f = fixture((volume) => {
    writeFileSync(join(volume, ".DS_Store"), "WindowBoundsiconSize");
    mkdirSync(join(volume, ".background"), { recursive: true });
    writeFileSync(join(volume, ".background", "background.png"), "png");
  });
  try {
    const verdict = verifyDmgAesthetics(f.dmg, { hdiutil: f.hdiutil });
    assert.equal(verdict.ok, false);
    assert.match(verdict.why, /backgroundImageAlias/u);
  } finally {
    f.cleanup();
  }
});

test("DMG 取证：引用了背景但图不在卷内也要报（不能只看 .DS_Store）", () => {
  const f = fixture((volume) => {
    writeFileSync(join(volume, ".DS_Store"), BACKGROUND_KEY);
  });
  try {
    const verdict = verifyDmgAesthetics(f.dmg, { hdiutil: f.hdiutil });
    assert.equal(verdict.ok, false);
    assert.match(verdict.why, /background\.png 不在卷内/u);
  } finally {
    f.cleanup();
  }
});

test("DMG 取证：齐全判通过，并且取证完必须卸载", () => {
  const f = fixture(withBackground);
  try {
    const verdict = verifyDmgAesthetics(f.dmg, { hdiutil: f.hdiutil });
    assert.deepEqual(verdict, { ok: true, why: null });
    const calls = readFileSync(f.calls, "utf8");
    assert.match(calls, /^attach/mu, "必须真的挂载过");
    assert.match(calls, /^detach/mu, "必须卸载，不能把挂载点留给后续步骤");
  } finally {
    f.cleanup();
  }
});

test("DMG 取证：挂不上时如实报「无法取证」，不假装通过", () => {
  const root = mkdtempSync(join(tmpdir(), "kfw-dmg-broken-"));
  const hdiutil = join(root, "hdiutil");
  writeFileSync(hdiutil, '#!/bin/sh\necho "mount 失败" >&2\nexit 1\n');
  chmodSync(hdiutil, 0o755);
  try {
    const verdict = verifyDmgAesthetics(join(root, "x.dmg"), { hdiutil });
    assert.equal(verdict.ok, false);
    assert.match(verdict.why, /挂不上/u);
    assert.match(verdict.why, /mount 失败/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
